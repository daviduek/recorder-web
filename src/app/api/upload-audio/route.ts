/**
 * POST /api/upload-audio
 *
 * New entry point for the transcription flow. Accepts a GCS URI (after the
 * client uploads via /api/upload-url) plus session/user metadata, and
 * returns a TranscriptionJob ready for polling.
 *
 * ─── Full flow ────────────────────────────────────────────────────────────────
 *
 *  Step 1 — Get a signed upload URL (existing):
 *    POST /api/upload-url  { mimeType }
 *    ← { gcsUri, uploadUrl, downloadUrl }
 *
 *  Step 2 — Upload the file directly to GCS from the browser:
 *    PUT <uploadUrl>  (binary audio body, Content-Type: mimeType)
 *
 *  Step 3 — Start transcription (this endpoint):
 *    POST /api/upload-audio  { gcsUri, mimeType, durationSeconds, sessionId, userId }
 *    ← { job, sessionId, userId }
 *
 *  Step 4 — Poll until done (existing):
 *    POST /api/transcription-jobs/status  { job }
 *    ← { done: false, progress } | { done: true, transcript, ai_response_es, ... }
 *
 *  Step 5 — Persist (existing, now with session/user fields):
 *    POST /api/recordings  { transcript, summary, session_id, user_id, ... }
 *    ← { recording }
 *
 * ─── Routing logic ────────────────────────────────────────────────────────────
 *
 *  This endpoint delegates routing to transcription-service.ts:
 *    - File ≤ 24 MB + OPENAI_API_KEY → mode: "openai_direct" (Whisper)
 *    - File  > 24 MB or no key       → mode: "google" (Google STT, handles 1h+)
 *
 * ─── Request body ─────────────────────────────────────────────────────────────
 *  {
 *    gcsUri:           string   — required; gs://bucket/recordings/uuid.mp3
 *    mimeType:         string   — optional; defaults to "audio/webm"
 *    durationSeconds:  number   — optional; used for progress estimation
 *    sessionId:        string   — optional; client-generated session UUID
 *    userId:           string   — optional; from the existing auth system
 *    selectedLanguages: string[] — optional; ["es-AR","en-US","iw-IL"]
 *  }
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *  {
 *    job:       TranscriptionJob   — pass this to /api/transcription-jobs/status
 *    sessionId: string | null
 *    userId:    string | null
 *  }
 */

import { NextResponse } from "next/server";

import { createTranscriptionJob } from "@/lib/transcription-service";
import type { SupportedLanguage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_LANGUAGES = new Set<SupportedLanguage>(["es-AR", "en-US", "iw-IL"]);

type UploadAudioBody = {
  gcsUri?: string;
  mimeType?: string;
  durationSeconds?: number;
  sessionId?: string;
  userId?: string;
  selectedLanguages?: string[];
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as UploadAudioBody;

    if (!body.gcsUri || !body.gcsUri.startsWith("gs://")) {
      return NextResponse.json(
        { error: "gcsUri es obligatorio y debe comenzar con gs://" },
        { status: 400 },
      );
    }

    const mimeType = (body.mimeType ?? "audio/webm").trim();

    const durationSeconds = Number.isFinite(Number(body.durationSeconds))
      ? Number(body.durationSeconds)
      : 0;

    const selectedLanguages = Array.isArray(body.selectedLanguages)
      ? body.selectedLanguages.filter((l): l is SupportedLanguage =>
          VALID_LANGUAGES.has(l as SupportedLanguage),
        )
      : undefined;

    const job = await createTranscriptionJob({
      gcsUri: body.gcsUri,
      mimeType,
      durationSeconds,
      selectedLanguages,
    });

    return NextResponse.json({
      job,
      sessionId: body.sessionId ?? null,
      userId: body.userId ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo iniciar la transcripción.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
