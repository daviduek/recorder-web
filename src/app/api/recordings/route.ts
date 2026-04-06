import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  buildSummaryAudio,
  summarizeTranscript,
  transcribeFromGcs,
} from "@/lib/google-pipeline";
import { appendRecording, readRecordings } from "@/lib/recordings-store";
import type { RecordingItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ProcessRecordingBody = {
  gcsUri?: string;
  inputAudioUrl?: string;
  durationSeconds?: number;
  mimeType?: string;
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
    const body = (await request.json()) as ProcessRecordingBody;
    const gcsUri = body.gcsUri?.trim();
    const mimeType = body.mimeType?.trim() || "audio/webm";
    const durationSeconds = Number(body.durationSeconds ?? 0);

    if (!gcsUri) {
      return NextResponse.json(
        { error: "No se recibio el gs:// URI del audio." },
        { status: 400 },
      );
    }

    const id = randomUUID();
    const { transcript, detectedLanguage, speakerCount, speakerRoles } = await transcribeFromGcs(
      gcsUri,
      mimeType,
    );
    const summary = await summarizeTranscript(transcript);
    const summaryAudioBuffer = await buildSummaryAudio(summary, detectedLanguage);
    const summaryAudioDataUrl = `data:audio/mpeg;base64,${summaryAudioBuffer.toString("base64")}`;

    const recording: RecordingItem = {
      id,
      createdAt: new Date().toISOString(),
      inputAudioUrl: body.inputAudioUrl,
      inputAudioStorageUri: gcsUri,
      summaryAudioDataUrl,
      transcript,
      summary,
      detectedLanguage,
      speakerCount,
      speakerRoles,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    };

    if (!process.env.VERCEL) {
      await appendRecording(recording);
    }

    return NextResponse.json({ recording }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No pudimos procesar la grabacion.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
