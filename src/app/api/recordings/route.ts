import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { appendRecording, readRecordings } from "@/lib/recordings-store";
import type { RecordingItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateRecordingBody = {
  // ── Required ───────────────────────────────────────────────────────────────
  transcript?: string;
  summary?: string;
  // ── Session & user context (new) ───────────────────────────────────────────
  session_id?: string;
  user_id?: string;
  // ── Explicit new field names (preferred) ───────────────────────────────────
  original_text?: string;
  ai_response_es?: string;
  translations?: Partial<Record<"es-AR" | "en-US" | "iw-IL", string>>;
  // ── Audio ──────────────────────────────────────────────────────────────────
  inputAudioUrl?: string;
  inputAudioStorageUri?: string;
  summaryAudioDataUrl?: string;
  // ── Metadata ───────────────────────────────────────────────────────────────
  detectedLanguage?: RecordingItem["detectedLanguage"];
  detectedLanguages?: RecordingItem["detectedLanguages"];
  durationSeconds?: number;
  speakerCount?: number;
  speakerRoles?: string[];
};

export async function GET() {
  if (process.env.VERCEL) {
    return NextResponse.json({ recordings: [] });
  }

  try {
    const recordings = await readRecordings();
    return NextResponse.json({ recordings });
  } catch {
    return NextResponse.json({ recordings: [] });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateRecordingBody;

    // Accept either the legacy field names or the new explicit ones
    const transcriptText = body.original_text ?? body.transcript;
    const summaryText = body.ai_response_es ?? body.summary;

    if (!transcriptText || !summaryText) {
      return NextResponse.json(
        {
          error:
            "Faltan campos requeridos: transcript (o original_text) y summary (o ai_response_es).",
        },
        { status: 400 },
      );
    }

    const recording: RecordingItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),

      // ── Session & user context ──────────────────────────────────────────────
      session_id: body.session_id,
      user_id: body.user_id,

      // ── Audio sources ───────────────────────────────────────────────────────
      inputAudioUrl: body.inputAudioUrl,
      inputAudioStorageUri: body.inputAudioStorageUri,
      summaryAudioDataUrl: body.summaryAudioDataUrl,

      // ── Transcription ───────────────────────────────────────────────────────
      original_text: transcriptText,
      transcript: transcriptText, // backward compat

      // ── AI response ─────────────────────────────────────────────────────────
      ai_response_es: summaryText,
      summary: summaryText, // backward compat

      // ── Traducciones ────────────────────────────────────────────────────────
      translations: body.translations,

      // ── Language metadata ───────────────────────────────────────────────────
      detectedLanguage: body.detectedLanguage ?? "unknown",
      detectedLanguages: Array.isArray(body.detectedLanguages)
        ? body.detectedLanguages.filter(
            (l): l is "es-AR" | "en-US" | "iw-IL" =>
              l === "es-AR" || l === "en-US" || l === "iw-IL",
          )
        : undefined,

      // ── Speaker metadata ────────────────────────────────────────────────────
      durationSeconds: Number.isFinite(Number(body.durationSeconds))
        ? Number(body.durationSeconds)
        : 0,
      speakerCount: Math.max(1, Math.min(3, Number(body.speakerCount ?? 1))),
      speakerRoles: Array.isArray(body.speakerRoles)
        ? body.speakerRoles.slice(0, 3)
        : undefined,
    };

    if (!process.env.VERCEL) {
      await appendRecording(recording);
    }

    return NextResponse.json({ recording }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No pudimos guardar la grabacion.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
