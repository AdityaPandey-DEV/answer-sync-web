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

    // 3. Get API key
    await resetDailyCreditsIfNeeded(user);
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let apiKey = "";
    if (dbUser.geminiApiKey) {
      apiKey = decrypt(dbUser.geminiApiKey);
    } else {
      const settings = await getAdminSettings();
      apiKey = settings.adminGeminiApiKey || "";
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "No API key configured." },
        { status: 503 }
      );
    }

    // 4. Check credits
    const creditLimit = dbUser.dailyCreditLimit || 20;
    if (!dbUser.geminiApiKey && dbUser.dailyCreditsUsed >= creditLimit) {
      return NextResponse.json(
        { error: "Daily credit limit reached." },
        { status: 429 }
      );
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

    // 7. Parse response
    const questions = parseUniversalResponse(geminiResponse.text);

    // 8. Deduct credit
    if (!dbUser.geminiApiKey) {
      await prisma.user.update({
        where: { id: user.id },
        data: { dailyCreditsUsed: { increment: 1 } },
      });
    }

    const creditsRemaining = dbUser.geminiApiKey
      ? 999
      : creditLimit - dbUser.dailyCreditsUsed - 1;

    return NextResponse.json({
      questions,
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

  return `You are analyzing a quiz/exam/assessment webpage. Your task is to identify ALL questions and provide the correct answer for each.

INSTRUCTIONS:
1. Read the page text below carefully
2. Identify every question (look for numbered items, question marks, or multiple-choice patterns)
3. For each question, identify the answer options if they exist
4. Provide the most accurate answer for each question

IMPORTANT RULES:
- For multiple-choice: Return the EXACT text of the correct option as it appears on the page
- For fill-in-the-blank: Return a concise, accurate answer
- For true/false: Return "True" or "False"
- Identify the answer options EXACTLY as written on the page (the user will need to click them)
- Return ONLY valid JSON, no markdown, no explanation

RETURN FORMAT (JSON array):
[
  {
    "id": "q_0",
    "question": "the full question text",
    "options": ["Option A text", "Option B text", "Option C text"],
    "answer": "exact text of correct option",
    "confidence": 0.95
  }
]

${pageUrl ? `PAGE URL: ${pageUrl}\n` : ""}
PAGE TEXT:
---
${trimmedText}
---`;
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

  try {
    // Find JSON array anywhere in response (handles thinking tokens)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0].replace(/```json\s*/g, "").replace(/```\s*/g, "");
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any, i: number) => ({
          id: item.id || `q_${i}`,
          question: String(item.question || ""),
          options: Array.isArray(item.options) ? item.options.map(String) : [],
          answer: typeof item.answer === "object" ? JSON.stringify(item.answer) : String(item.answer || ""),
          confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
        }));
      }
    }
  } catch (e) {
    console.error("[solve-text] Parse error:", e, text?.substring(0, 200));
  }

  return [];
}
