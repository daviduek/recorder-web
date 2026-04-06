import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  buildSummaryAudio,
  summarizeTranscript,
  transcribeAudio,
} from "@/lib/google-pipeline";
import {
  appendRecording,
  readRecordings,
  saveInputAudio,
  saveSummaryAudio,
} from "@/lib/recordings-store";
import type { RecordingItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extensionFromMime(mimeType: string) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

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
    const formData = await request.formData();
    const audio = formData.get("audio");
    const durationRaw = formData.get("durationSeconds");
    const durationSeconds =
      typeof durationRaw === "string" ? Number(durationRaw) : 0;

    if (!(audio instanceof File)) {
      return NextResponse.json(
        { error: "No se recibio el audio." },
        { status: 400 },
      );
    }

    const mimeType = audio.type || "audio/webm";
    const id = randomUUID();
    const inputBuffer = Buffer.from(await audio.arrayBuffer());

    const inputAudioDataUrl = `data:${mimeType};base64,${inputBuffer.toString("base64")}`;

    const { transcript, detectedLanguage } = await transcribeAudio(
      inputBuffer,
      mimeType,
    );
    const summary = await summarizeTranscript(transcript);
    const summaryAudioBuffer = await buildSummaryAudio(summary, detectedLanguage);
    const summaryAudioDataUrl = `data:audio/mpeg;base64,${summaryAudioBuffer.toString("base64")}`;

    let inputAudioUrl: string | undefined;
    let summaryAudioUrl: string | undefined;

    if (!process.env.VERCEL) {
      inputAudioUrl = await saveInputAudio(
        id,
        extensionFromMime(mimeType),
        inputBuffer,
      );
      summaryAudioUrl = await saveSummaryAudio(id, summaryAudioBuffer);
    }

    const recording: RecordingItem = {
      id,
      createdAt: new Date().toISOString(),
      inputAudioUrl,
      summaryAudioUrl,
      inputAudioDataUrl,
      summaryAudioDataUrl,
      transcript,
      summary,
      detectedLanguage,
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
