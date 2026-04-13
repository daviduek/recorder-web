/**
 * transcription-service.ts
 *
 * Whisper-first routing layer for audio transcription.
 *
 * Routing strategy (checked in order):
 *  1. File size ≤ 24 MB AND OPENAI_API_KEY set
 *     → mode: "openai_direct"  (OpenAI gpt-4o-transcribe via existing pipeline)
 *  2. Otherwise
 *     → mode: "google"         (Google Cloud STT LongRunningRecognize)
 *
 * Both paths are polled via the EXISTING /api/transcription-jobs/status endpoint.
 * This module does NOT replace google-pipeline.ts — it sits in front of it as
 * a size-aware routing layer for the new /api/upload-audio endpoint.
 *
 * For files > 24 MB (e.g. 1-hour MP3 at 128 kbps ≈ 57 MB), Google STT is used
 * because it accepts GCS URIs directly with no file-size limit.
 *
 * Chunking note: splitting compressed audio (MP3/M4A) without re-encoding
 * requires ffmpeg. Rather than add that dependency, we route large files to
 * Google STT which already handles them reliably in production.
 */

import { Storage } from "@google-cloud/storage";

import { startTranscriptionJob, type TranscriptionJob } from "@/lib/google-pipeline";
import type { SupportedLanguage } from "@/lib/types";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Files at or below this size are sent to OpenAI Whisper.
 * OpenAI's hard limit is 25 MB; we leave 1 MB margin.
 */
const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // 24 MB

// ─── GCS helpers ──────────────────────────────────────────────────────────────

function parseGcsUri(gcsUri: string): { bucket: string; objectPath: string } | null {
  if (!gcsUri.startsWith("gs://")) return null;
  const withoutScheme = gcsUri.slice("gs://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0) return null;
  return {
    bucket: withoutScheme.slice(0, slash),
    objectPath: withoutScheme.slice(slash + 1),
  };
}

function buildStorageClient(): Storage {
  const inline = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
  if (inline) {
    try {
      const json = inline.startsWith("{")
        ? (JSON.parse(inline) as { project_id?: string; client_email: string; private_key: string })
        : (JSON.parse(Buffer.from(inline, "base64").toString("utf-8")) as {
            project_id?: string;
            client_email: string;
            private_key: string;
          });
      return new Storage({
        projectId: json.project_id,
        credentials: { client_email: json.client_email, private_key: json.private_key },
      });
    } catch {
      // fall through to ADC
    }
  }
  return new Storage();
}

// Lazy singleton — avoids parsing credentials on every import.
let _storage: Storage | null = null;
function getStorage(): Storage {
  if (!_storage) _storage = buildStorageClient();
  return _storage;
}

/**
 * Returns the file size in bytes from GCS object metadata.
 * Returns 0 if the URI is invalid or the call fails.
 */
async function getGcsFileSizeBytes(gcsUri: string): Promise<number> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) return 0;

  try {
    const [metadata] = await getStorage()
      .bucket(parsed.bucket)
      .file(parsed.objectPath)
      .getMetadata();
    return Number(metadata.size ?? 0);
  } catch {
    return 0;
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type CreateJobParams = {
  /** GCS URI of the already-uploaded audio file (gs://bucket/path). */
  gcsUri: string;
  /** MIME type, e.g. "audio/mp3", "audio/wav", "audio/m4a". */
  mimeType: string;
  /** Duration estimate in seconds (used for progress calculation). */
  durationSeconds: number;
  /** Languages the user selected. Omit to auto-detect all supported. */
  selectedLanguages?: SupportedLanguage[];
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a TranscriptionJob compatible with the existing polling
 * infrastructure at /api/transcription-jobs/status.
 *
 * - Small files (≤ 24 MB) + OpenAI key available
 *     → Returns `{ mode: "openai_direct", ... }`.
 *       The status poller downloads the file and calls gpt-4o-transcribe.
 *
 * - Large files OR no OpenAI key
 *     → Returns `{ mode: "google", operations: [...] }`.
 *       The status poller checks Google STT long-running operations.
 *
 * @example
 * // In /api/upload-audio
 * const job = await createTranscriptionJob({ gcsUri, mimeType, durationSeconds });
 * return NextResponse.json({ job, sessionId, userId });
 *
 * // Client then polls:
 * POST /api/transcription-jobs/status  { job }
 */
export async function createTranscriptionJob(
  params: CreateJobParams,
): Promise<TranscriptionJob> {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

  if (hasOpenAI) {
    const fileSizeBytes = await getGcsFileSizeBytes(params.gcsUri);
    const fitsInWhisper = fileSizeBytes > 0 && fileSizeBytes <= WHISPER_MAX_BYTES;

    if (fitsInWhisper) {
      // Signal to the existing poller to use the OpenAI/Whisper path directly.
      // pollTranscriptionJob in google-pipeline.ts handles mode: "openai_direct"
      // by downloading from GCS and calling transcribeWithPremiumFallback.
      return {
        operations: [],
        mimeType: params.mimeType,
        gcsUri: params.gcsUri,
        selectedLanguages: params.selectedLanguages,
        mode: "openai_direct",
      };
    }
  }

  // File too large for Whisper, or no OpenAI key configured.
  // Delegate to Google Cloud STT (handles multi-hour audio via GCS URIs).
  return startTranscriptionJob(params);
}
