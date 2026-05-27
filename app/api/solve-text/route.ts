import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import {
  validateExtensionToken,
  getAdminSettings,
  resetDailyCreditsIfNeeded,
} from "@/lib/auth-helpers";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
  "gemini-flash-latest",
];

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const user = await validateExtensionToken(
      request.headers.get("Authorization")
    );
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse request
    const body = await request.json();
    const pageText = body.pageText;
    const pageUrl = body.pageUrl || "";

    if (!pageText || typeof pageText !== "string" || pageText.trim().length < 20) {
      return NextResponse.json(
        { error: "No readable text found on this page." },
        { status: 400 }
      );
    }

    // 3. Get admin settings
    const settings = await getAdminSettings();

    // 4. Determine API key
    let apiKey: string;

    if (
      user.tier === "pro" &&
      user.encryptedApiKey &&
      user.apiKeyIv &&
      user.apiKeyTag
    ) {
      try {
        apiKey = decrypt(user.encryptedApiKey, user.apiKeyIv, user.apiKeyTag);
      } catch {
        return NextResponse.json(
          { error: "Failed to decrypt your API key. Please re-save it on the dashboard." },
          { status: 500 }
        );
      }
    } else {
      // Free user: use admin key with credit check
      await resetDailyCreditsIfNeeded(user.id);

      const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!freshUser) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      if (freshUser.dailyCreditsUsed >= settings.dailyCreditLimit) {
        return NextResponse.json(
          { error: "Daily credit limit reached." },
          { status: 429 }
        );
      }

      apiKey = process.env.ADMIN_GEMINI_API_KEY || "";
      if (!apiKey) {
        return NextResponse.json(
          { error: "Service temporarily unavailable. Admin key not configured." },
          { status: 503 }
        );
      }
    }

    // 5. Build the universal prompt
    const prompt = buildUniversalPrompt(pageText, pageUrl);

    // 6. Call Gemini
    const geminiResponse = await callGeminiWithFallback(apiKey, prompt);

    if (geminiResponse.error) {
      return NextResponse.json(
        { error: geminiResponse.error },
        { status: 502 }
      );
    }

    console.log("[solve-text] Gemini raw response:", geminiResponse.text?.substring(0, 500));

    // 7. Parse response
    const questions = parseUniversalResponse(geminiResponse.text);
    console.log("[solve-text] Parsed questions count:", questions.length);

    // 8. Deduct credit (free users only)
    if (user.tier !== "pro") {
      await prisma.user.update({
        where: { id: user.id },
        data: { dailyCreditsUsed: { increment: 1 } },
      });
    }

    const freshUser2 = await prisma.user.findUnique({ where: { id: user.id } });
    const creditsRemaining = user.tier === "pro"
      ? 999
      : settings.dailyCreditLimit - (freshUser2?.dailyCreditsUsed || 0);

    return NextResponse.json({
      questions,
      rawText: questions.length === 0 ? geminiResponse.text?.substring(0, 2000) : undefined,
      creditsRemaining: Math.max(0, creditsRemaining),
    });
  } catch (error: any) {
    console.error("[solve-text] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ---- Universal Prompt ----
function buildUniversalPrompt(pageText: string, pageUrl: string): string {
  // Trim text to avoid token limits (keep first 6000 chars)
  const trimmedText = pageText.length > 6000
    ? pageText.substring(0, 6000) + "\n...[truncated]"
    : pageText;

  return `You are a quiz/exam answer engine. Below is visible text from a quiz webpage. Find EVERY question and provide the correct answer.

CRITICAL: You MUST return at least one question. The text below is from a real quiz page - look carefully for questions, even if the text contains navigation or other noise.

RULES:
- For multiple-choice: Return the EXACT text of the correct option as written on the page
- For multi-select ("select TWO", "select all that apply"): Return a JSON array of correct options as the answer, e.g. ["Option A", "Option C"]
- For fill-in-the-blank: Return a concise answer
- For true/false: Return "True" or "False"
- NEVER return an empty array []
- You MUST find at least one question in the text below

Return ONLY a JSON array (no markdown, no explanation, no code fences):
[{"id":"q_0","question":"full question text","options":["option1","option2"],"answer":"exact correct option text","confidence":0.95}]

${pageUrl ? `PAGE URL: ${pageUrl}\n` : ""}
PAGE CONTENT:
${trimmedText}`;
}

// ---- Gemini API Call with Model Fallback ----
async function callGeminiWithFallback(
  apiKey: string,
  prompt: string
): Promise<{ text?: string; error?: string }> {
  let lastError = "";
  for (const model of GEMINI_MODELS) {
    const result = await callGemini(apiKey, prompt, model);
    if (result.text) return result;
    lastError = result.error || "Unknown error";
    if (lastError.includes("503") || lastError.includes("429") || lastError.includes("UNAVAILABLE")) {
      continue;
    }
    return result;
  }
  return { error: lastError };
}

async function callGemini(
  apiKey: string,
  prompt: string,
  model: string
): Promise<{ text?: string; error?: string }> {
  try {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { error: `Gemini API error (${res.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { text };
  } catch (e: any) {
    return { error: `Network error: ${e.message}` };
  }
}

// ---- Parse Response ----
function parseUniversalResponse(
  text: string | undefined
): Array<{ id: string; question: string; options: string[]; answer: string; confidence: number }> {
  if (!text) return [];

  // Remove thinking tokens first
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Remove markdown code fences
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Strategy 1: Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return mapParsedQuestions(parsed);
    }
  } catch (e) {
    // Not clean JSON, try extraction strategies
  }

  // Strategy 2: Find JSON array using balanced bracket matching
  try {
    const startIdx = text.indexOf('[');
    if (startIdx !== -1) {
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < text.length; i++) {
        if (text[i] === '[') depth++;
        if (text[i] === ']') depth--;
        if (depth === 0) { endIdx = i; break; }
      }
      if (endIdx > startIdx) {
        let jsonStr = text.substring(startIdx, endIdx + 1);
        jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return mapParsedQuestions(parsed);
        }
      }
    }
  } catch (e) {
    console.error("[solve-text] Bracket parse error:", e, text?.substring(0, 300));
  }

  // Strategy 3: Code fence extraction
  try {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return mapParsedQuestions(parsed);
    }
  } catch (e) {}

  return [];
}

function mapParsedQuestions(parsed: any[]) {
  return parsed.map((item: any, i: number) => ({
    id: item.id || `q_${i}`,
    question: String(item.question || ""),
    options: Array.isArray(item.options) ? item.options.map(String) : [],
    answer: typeof item.answer === "object" ? JSON.stringify(item.answer) : String(item.answer || ""),
    confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
  }));
}
