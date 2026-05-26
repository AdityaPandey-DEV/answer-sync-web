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
    const questions = body.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return NextResponse.json(
        { error: "No questions provided" },
        { status: 400 }
      );
    }

    // 3. Get admin settings
    const settings = await getAdminSettings();

    // Cap the batch size
    const cappedQuestions = questions.slice(0, settings.maxQuestionsPerBatch);

    // 4. Determine which API key to use
    let apiKey: string;

    if (
      user.tier === "pro" &&
      user.encryptedApiKey &&
      user.apiKeyIv &&
      user.apiKeyTag
    ) {
      // Pro user: decrypt their stored API key
      try {
        apiKey = decrypt(user.encryptedApiKey, user.apiKeyIv, user.apiKeyTag);
      } catch {
        return NextResponse.json(
          {
            error:
              "Failed to decrypt your API key. Please re-save it on the dashboard.",
          },
          { status: 500 }
        );
      }
    } else {
      // Free user: use admin key with credit check
      await resetDailyCreditsIfNeeded(user.id);

      // Re-fetch user to get updated credit count
      const freshUser = await prisma.user.findUnique({
        where: { id: user.id },
      });
      if (!freshUser) {
        return NextResponse.json(
          { error: "User not found" },
          { status: 404 }
        );
      }

      if (freshUser.dailyCreditsUsed >= settings.dailyCreditLimit) {
        return NextResponse.json(
          {
            error:
              "Daily credit limit reached. Add your own API key on the dashboard for unlimited access.",
          },
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

    // 5. Build the prompt
    const prompt = buildPrompt(cappedQuestions);

    // 6. Call Gemini API (with model fallback)
    const geminiResponse = await callGeminiWithFallback(apiKey, prompt);

    if (geminiResponse.error) {
      return NextResponse.json(
        { error: geminiResponse.error },
        { status: 502 }
      );
    }

    // 7. Parse AI response
    const answers = parseGeminiResponse(geminiResponse.text, cappedQuestions);

    // 8. Update usage
    const creditCost = user.tier === "pro" ? 0 : 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        dailyCreditsUsed: { increment: creditCost },
        totalQueriesAll: { increment: 1 },
      },
    });

    // 9. Calculate remaining credits
    let creditsRemaining: number | undefined;
    if (user.tier !== "pro") {
      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
      });
      creditsRemaining = updatedUser
        ? Math.max(0, settings.dailyCreditLimit - updatedUser.dailyCreditsUsed)
        : 0;
    }

    return NextResponse.json({
      answers,
      creditsRemaining,
    });
  } catch (error: any) {
    console.error("Solve API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ---- Prompt Builder ----
function buildPrompt(
  questions: Array<{
    id: string;
    type: string;
    questionText: string;
    options: string[];
    context: string;
  }>
): string {
  const questionsList = questions
    .map((q, i) => {
      let entry = `${i + 1}. [ID: ${q.id}] [Type: ${q.type}] Question: ${q.questionText}`;
      if (q.options && q.options.length > 0) {
        entry += `\n   Options: ${q.options.join(" | ")}`;
      }
      if (q.context) {
        entry += `\n   Context: ${q.context.substring(0, 200)}`;
      }
      return entry;
    })
    .join("\n\n");

  return `You are a precise answer engine. Given the following questions from a webpage, provide the most accurate answer for each.

IMPORTANT RULES:
- For "radio" type: Return the EXACT text of the correct option from the given options list.
- For "checkbox" type: Return a JSON array of the correct option texts, e.g. ["Option A", "Option C"].
- For "text" or "textarea" type: Return a concise, accurate answer.
- For "number" type: Return only the number.
- For "date" type: Return in YYYY-MM-DD format.
- For "select" type: Return the EXACT text of the correct option.
- For "email" type: Return a valid email if one can be determined from context.

Return ONLY a valid JSON array. No markdown, no code fences, no explanation. Just the JSON array.

Format:
[
  { "id": "q_0", "answer": "exact answer", "confidence": 0.95 },
  { "id": "q_1", "answer": "exact answer", "confidence": 0.8 }
]

QUESTIONS:
${questionsList}`;
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
    // If it's a 503/429, try next model
    if (lastError.includes("503") || lastError.includes("429") || lastError.includes("UNAVAILABLE")) {
      console.log(`[solve] Model ${model} unavailable, trying next...`);
      continue;
    }
    // For other errors (auth, bad request), don't retry
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
      return {
        error: `Gemini API error (${res.status}): ${errBody.substring(0, 200)}`,
      };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { text };
  } catch (e: any) {
    return { error: `Network error: ${e.message}` };
  }
}

// ---- Parse Gemini Response ----
function parseGeminiResponse(
  text: string | undefined,
  questions: Array<{ id: string }>
): Array<{ id: string; answer: string; confidence: number }> {
  if (!text) {
    return questions.map((q) => ({
      id: q.id,
      answer: "Could not generate answer",
      confidence: 0,
    }));
  }

  try {
    // Clean up the response — remove code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => ({
        id: item.id || "",
        answer: typeof item.answer === "object"
          ? JSON.stringify(item.answer)
          : String(item.answer || ""),
        confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
      }));
    }
  } catch (e) {
    console.error("Failed to parse Gemini response:", e, text);
  }

  // Fallback: return raw text for first question
  return questions.map((q, i) => ({
    id: q.id,
    answer: i === 0 ? text : "Could not parse answer",
    confidence: 0.3,
  }));
}
