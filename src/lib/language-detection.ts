/**
 * language-detection.ts
 *
 * Detects languages within a transcript and inserts inline language
 * boundary markers ([HE], [EN], [ES]) where the spoken language changes.
 *
 * Pipeline:
 *  1. Heuristic pass — fast, zero-cost, based on Unicode ranges & keywords.
 *  2. GPT post-processing — inserts [HE]/[EN]/[ES] tags at detected boundaries.
 *     Uses OpenAI as primary, Gemini as fallback.
 *  3. Script-based heuristic — last resort for Hebrew/Latin distinction only.
 *
 * Both functions are pure async — safe to call in parallel with other work.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

import type { SupportedLanguage } from "@/lib/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED: SupportedLanguage[] = ["es-AR", "en-US", "iw-IL"];

/** Maps lowercase language names / codes → SupportedLanguage. */
const LANG_NAME_TO_CODE: Record<string, SupportedLanguage> = {
  spanish: "es-AR",
  español: "es-AR",
  "es-ar": "es-AR",
  es: "es-AR",
  english: "en-US",
  inglés: "en-US",
  ingles: "en-US",
  "en-us": "en-US",
  en: "en-US",
  hebrew: "iw-IL",
  hebreo: "iw-IL",
  "iw-il": "iw-IL",
  "he-il": "iw-IL",
  iw: "iw-IL",
  he: "iw-IL",
};

// ─── Heuristics ───────────────────────────────────────────────────────────────

function hasHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text);
}

function detectHeuristic(text: string): Set<SupportedLanguage> {
  const found = new Set<SupportedLanguage>();
  const lower = text.toLowerCase();

  if (hasHebrew(text)) found.add("iw-IL");

  if (
    /[¿¡áéíóúñ]/i.test(text) ||
    /\b(el|la|los|las|de|que|para|como|pero|bien|una|con|por|más|este|eso)\b/.test(lower)
  ) {
    found.add("es-AR");
  }

  if (
    /\b(the|and|with|this|that|is|are|you|we|have|from|they|our|your|it)\b/.test(lower)
  ) {
    found.add("en-US");
  }

  return found;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the SupportedLanguage codes present in the transcript.
 * Heuristics run first; Gemini confirms when GEMINI_API_KEY is set.
 */
export async function detectLanguagesFromTranscript(
  transcript: string,
): Promise<SupportedLanguage[]> {
  const detected = detectHeuristic(transcript);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !transcript.trim()) {
    return [...detected];
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Detecta los idiomas presentes en esta transcripcion.",
                "Responde SOLO con idiomas de esta lista: es-AR, en-US, iw-IL.",
                'Formato JSON estricto: {"languages":["es-AR","en-US"]}',
                "",
                "TRANSCRIPCION:",
                transcript.slice(0, 12_000),
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0 },
    });

    const raw = (response.text ?? "").trim();
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { languages?: string[] };

    for (const lang of parsed.languages ?? []) {
      const code = LANG_NAME_TO_CODE[lang.toLowerCase()];
      if (code) detected.add(code);
    }
  } catch {
    // keep heuristic results
  }

  return [...detected];
}

/**
 * Normalizes a language string from Whisper or GPT to a SupportedLanguage.
 * Returns null if unrecognized.
 */
export function normalizeToSupportedLanguage(
  lang: string | undefined | null,
): SupportedLanguage | null {
  if (!lang) return null;
  return LANG_NAME_TO_CODE[lang.toLowerCase().trim()] ?? null;
}

/**
 * Inserts [HE] / [EN] / [ES] tags at detected language-switch boundaries.
 *
 * Skips processing if the transcript is already tagged.
 * Uses OpenAI as primary, Gemini as fallback, heuristic as last resort.
 */
export async function addLanguageTags(transcript: string): Promise<string> {
  const trimmed = transcript.trim();
  if (!trimmed) return trimmed;

  // Skip if already tagged — avoid double-tagging on re-process
  if (/\[(HE|EN|ES)\]/.test(trimmed)) return trimmed;

  const SYSTEM = [
    "You are a language-tagging assistant.",
    "Insert language boundary markers into a transcript.",
    "Rules:",
    "1. Use ONLY: [HE] for Hebrew, [EN] for English, [ES] for Spanish.",
    "2. Insert the tag ONCE at the start of each language change.",
    "3. Do NOT add a tag at the very beginning unless the language was already identified.",
    "4. Do NOT translate, summarize, paraphrase, or alter any words.",
    "5. Keep all speaker tags like [S1], [S2], [S3] unchanged.",
    "6. Return ONLY the tagged transcript — no explanations.",
  ].join(" ");

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_SUMMARY_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: trimmed.slice(0, 30_000) },
        ],
      });
      const result = completion.choices[0]?.message?.content?.trim();
      if (result && result.length > 0) return result;
    } catch {
      // fall through to Gemini
    }
  }

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
                text: [
                  "Insertá marcadores de idioma donde cambia el idioma hablado.",
                  "Marcadores válidos: [HE] hebreo, [EN] inglés, [ES] español.",
                  "Reglas:",
                  "1. Insertá el marcador UNA VEZ al inicio de cada cambio de idioma.",
                  "2. NO traduzcas ni modifiques ninguna palabra.",
                  "3. Conservá etiquetas [S1], [S2], [S3] sin cambios.",
                  "4. Devolvé SOLO la transcripción marcada, sin explicaciones.",
                  "",
                  "TRANSCRIPCIÓN:",
                  trimmed.slice(0, 30_000),
                ].join("\n"),
              },
            ],
          },
        ],
        config: { temperature: 0 },
      });
      const result = response.text?.trim();
      if (result && result.length > 0) return result;
    } catch {
      // fall through to heuristic
    }
  }

  // Last resort: tag Hebrew↔Latin boundaries by Unicode script
  return insertTagsHeuristic(trimmed);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Heuristic fallback: inserts [HE] when switching into Hebrew characters,
 * and a generic marker when switching back to Latin script.
 * Cannot distinguish Spanish from English — used only when no AI is available.
 */
function insertTagsHeuristic(text: string): string {
  if (!hasHebrew(text)) return text;

  let result = "";
  let inHebrew: boolean | null = null;

  for (const char of text) {
    const isHebrew = /[\u0590-\u05FF]/.test(char);

    if (char.trim().length > 0 && isHebrew !== inHebrew) {
      result += isHebrew ? "[HE] " : "[?] "; // [?] = unknown Latin language
      inHebrew = isHebrew;
    }

    result += char;
  }

  return result.trim();
}
