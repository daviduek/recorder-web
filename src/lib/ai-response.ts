/**
 * ai-response.ts
 *
 * Generates a structured AI response ALWAYS in Spanish, regardless of the
 * input language(s). Kept as a standalone module so it can evolve
 * independently of the transcription pipeline.
 *
 * Output format:
 *   1) Contexto general  — 1–2 lines
 *   2) Puntos clave      — 3–6 bullets starting with "• "
 *   3) Cierre / acciones — 1–2 lines
 *
 * Primary:  OpenAI (model via OPENAI_SUMMARY_MODEL, default gpt-4o-mini)
 * Fallback: Google Gemini (model via GEMINI_MODEL, default gemini-2.5-flash)
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

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

  // ── Primary: OpenAI ────────────────────────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_SUMMARY_MODEL ?? "gpt-4o-mini",
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
