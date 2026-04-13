/**
 * ai-response.ts
 *
 * Two responsibilities:
 *
 * 1. generateSpanishResponse — structured AI analysis always in Spanish.
 *
 * 2. translateToAllLanguages — takes the full transcript (from Whisper, in
 *    whatever language was spoken) and uses GPT to produce a complete
 *    translation into each selected language.
 *    Rules:
 *      - Translate the ENTIRE content, never truncate or summarize.
 *      - Preserve speaker tags [S1], [S2], [S3] and language markers.
 *      - For Hebrew use Hebrew script, never transliterate.
 *      - Run all language translations in parallel (Promise.all).
 *
 * Primary model: gpt-4o (better multilingual / Hebrew quality).
 * Fallback:      gpt-4o-mini → Gemini.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

import type { SupportedLanguage } from "@/lib/types";

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Eres un analista experto en conversaciones multilingues. " +
  "Tu tarea es generar una respuesta estructurada SIEMPRE en ESPAÑOL, " +
  "sin importar el idioma en que fue grabada la conversación. " +
  "No traduzcas literalmente: analiza, sintetiza y responde. " +
  "No inventes hechos que no estén en la transcripción.";

const FORMAT_INSTRUCTIONS = [
  "Responde con este formato exacto:",
  "",
  "1) Contexto general (1-2 líneas).",
  "",
  "2) Puntos clave:",
  "• <punto 1>",
  "• <punto 2>",
  "• ... (entre 3 y 6 bullets)",
  "",
  "3) Cierre/acciones (1-2 líneas).",
].join("\n");

function buildUserPrompt(transcript: string): string {
  return `${FORMAT_INSTRUCTIONS}\n\nTranscripción:\n${transcript.slice(0, 30_000)}`;
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function buildFallbackResponse(transcript: string): string {
  const preview = transcript.trim().slice(0, 400);
  return [
    "1) Contexto general: Se procesó la transcripción del audio.",
    "",
    "2) Puntos clave:",
    `• ${preview}${preview.length < transcript.trim().length ? "..." : ""}`,
    "",
    "3) Cierre/acciones: Revisar la transcripción completa para más detalles.",
  ].join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a structured AI response in Spanish for the given transcript.
 *
 * The transcript may contain inline language tags ([HE], [EN], [ES])
 * and/or speaker tags ([S1], [S2]) — both are understood by the model.
 *
 * @param transcript - Full transcript text (tagged or plain).
 * @returns Structured Spanish response string.
 */
export async function generateSpanishResponse(
  transcript: string,
): Promise<string> {
  const trimmed = transcript.trim();
  if (!trimmed) return buildFallbackResponse("");

  // ── Primary: gpt-4.1 ──────────────────────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(trimmed) },
        ],
      });

      const result = completion.choices[0]?.message?.content?.trim();
      if (result && result.length > 40) return result;
    } catch {
      // fall through to gpt-4o
    }

    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(trimmed) },
        ],
      });

      const result = completion.choices[0]?.message?.content?.trim();
      if (result && result.length > 40) return result;
    } catch {
      // fall through to Gemini
    }
  }

  // ── Fallback: Gemini ───────────────────────────────────────────────────────
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${SYSTEM_PROMPT}\n\n${buildUserPrompt(trimmed)}`,
              },
            ],
          },
        ],
        config: { temperature: 0.3 },
      });

      const result = response.text?.trim();
      if (result && result.length > 40) return result;
    } catch {
      // fall through to static fallback
    }
  }

  return buildFallbackResponse(trimmed);
}

// ─── Translation ──────────────────────────────────────────────────────────────

const LANGUAGE_DISPLAY: Record<SupportedLanguage, string> = {
  "es-AR": "Spanish (Argentina)",
  "en-US": "English (US)",
  "iw-IL": "Hebrew",
};

const TRANSLATION_SYSTEM = (targetLang: string) =>
  [
    `You are a professional translator. Translate the following audio transcript to ${targetLang}.`,
    "Rules:",
    "1. Translate the COMPLETE transcript — every single line, never skip or summarize.",
    "2. If a section is already in the target language, keep it exactly as-is.",
    "3. Preserve all speaker tags like [S1], [S2], [S3] without changes.",
    "4. Preserve inline language markers like [HE], [EN], [ES] without changes.",
    "5. CRITICAL for Hebrew output: ALWAYS use Hebrew Unicode characters (א ב ג ד ה ו ז ח ט י...). NEVER write Hebrew words in Latin letters. No transliteration. No phonetics.",
    "6. Return ONLY the translated transcript, no explanations or headers.",
  ].join("\n");

/**
 * Translates the full transcript to a single target language using GPT.
 * Falls back to Gemini if OpenAI is unavailable.
 * Returns the original transcript if all attempts fail.
 */
export async function translateToLanguage(
  transcript: string,
  targetLanguage: SupportedLanguage,
): Promise<string> {
  const trimmed = transcript.trim();
  if (!trimmed) return trimmed;

  const langDisplay = LANGUAGE_DISPLAY[targetLanguage];
  const systemPrompt = TRANSLATION_SYSTEM(langDisplay);

  // ── Primary: gpt-4.1 (último modelo, mejor calidad multilingüe / hebreo) ────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1",
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmed },
        ],
      });

      const result = completion.choices[0]?.message?.content?.trim();
      if (result && result.length > 0) return result;
    } catch {
      // fall through to gpt-4o
    }

    // ── Fallback: gpt-4o ──────────────────────────────────────────────────────
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmed },
        ],
      });

      const result = completion.choices[0]?.message?.content?.trim();
      if (result && result.length > 0) return result;
    } catch {
      // fall through to Gemini
    }
  }

  // ── Fallback: Gemini ───────────────────────────────────────────────────────
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\nTRANSCRIPT:\n${trimmed}` }],
          },
        ],
        config: { temperature: 0.1 },
      });

      const result = response.text?.trim();
      if (result && result.length > 0) return result;
    } catch {
      // return original
    }
  }

  return trimmed;
}

/**
 * Translates the full transcript into ALL requested languages in parallel.
 * If a language matches the already-detected source language, still runs
 * translation so the output is cleaned and normalized.
 *
 * @param transcript - Full transcript (may contain [HE]/[EN]/[ES] tags).
 * @param languages  - Languages to translate into. Defaults to all 3.
 * @returns Map of language code → full translated transcript.
 */
export async function translateToAllLanguages(
  transcript: string,
  languages: SupportedLanguage[] = ["es-AR", "en-US", "iw-IL"],
): Promise<Partial<Record<SupportedLanguage, string>>> {
  if (!transcript.trim() || languages.length === 0) return {};

  const entries = await Promise.all(
    languages.map(async (lang) => {
      const translated = await translateToLanguage(transcript, lang);
      return [lang, translated] as [SupportedLanguage, string];
    }),
  );

  return Object.fromEntries(entries);
}
