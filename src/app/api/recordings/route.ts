import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { appendRecording, readRecordings } from "@/lib/recordings-store";
import type { RecordingItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateRecordingBody = {
  inputAudioUrl?: string;
  inputAudioStorageUri?: string;
  transcript?: string;
  summary?: string;
  summaryAudioDataUrl?: string;
  detectedLanguage?: RecordingItem["detectedLanguage"];
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
    if (!body.transcript || !body.summary) {
      return NextResponse.json(
        { error: "Faltan transcript/summary para guardar la grabacion." },
        { status: 400 },
      );
    }

    const recording: RecordingItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      inputAudioUrl: body.inputAudioUrl,
      inputAudioStorageUri: body.inputAudioStorageUri,
      summaryAudioDataUrl: body.summaryAudioDataUrl,
      transcript: body.transcript,
      summary: body.summary,
      detectedLanguage: body.detectedLanguage ?? "unknown",
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
