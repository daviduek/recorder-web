import { NextResponse } from "next/server";

import {
  buildSummaryAudio,
  pollTranscriptionJob,
  summarizeTranscript,
  type TranscriptionJob,
} from "@/lib/google-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusBody = {
  job?: TranscriptionJob;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as StatusBody;
    if (!body.job) {
      return NextResponse.json(
        { error: "Job invalido para consultar estado." },
        { status: 400 },
      );
    }
    if (
      body.job.mode !== "openai_direct" &&
      (!Array.isArray(body.job.operations) || body.job.operations.length === 0)
    ) {
      return NextResponse.json(
        { error: "Job invalido para consultar estado." },
        { status: 400 },
      );
    }

    const status = await pollTranscriptionJob(body.job);
    if (!status.done) {
      return NextResponse.json({
        done: false,
        progress: status.progress,
      });
    }

    const transcript = status.transcript?.trim() ?? "";
    if (!transcript) {
      return NextResponse.json(
        {
          error:
            "El audio se proceso pero no se detecto voz suficiente para transcribir. Reintenta con mayor volumen o menos ruido.",
        },
        { status: 422 },
      );
    }

    const detectedLanguage = status.detectedLanguage ?? "unknown";
    const summary = await summarizeTranscript(transcript);
    const summaryAudioBuffer = await buildSummaryAudio(summary, detectedLanguage);
    const summaryAudioDataUrl = `data:audio/mpeg;base64,${summaryAudioBuffer.toString("base64")}`;

    return NextResponse.json({
      done: true,
      progress: 100,
      transcript,
      detectedLanguage,
      detectedLanguages: status.detectedLanguages ?? [],
      speakerCount: status.speakerCount ?? 1,
      speakerRoles: status.speakerRoles ?? [],
      summary,
      summaryAudioDataUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo consultar el estado del job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
