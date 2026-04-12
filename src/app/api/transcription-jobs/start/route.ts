import { NextResponse } from "next/server";

import { startTranscriptionJob } from "@/lib/google-pipeline";
import type { SupportedLanguage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StartBody = {
  gcsUri?: string;
  mimeType?: string;
  durationSeconds?: number;
  selectedLanguages?: SupportedLanguage[];
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as StartBody;
    const gcsUri = body.gcsUri?.trim();
    const mimeType = body.mimeType?.trim() || "audio/webm";
    const durationSeconds = Number(body.durationSeconds ?? 0);
    const selectedLanguages = Array.isArray(body.selectedLanguages)
      ? body.selectedLanguages.filter(
          (language): language is SupportedLanguage =>
            language === "es-AR" || language === "en-US" || language === "iw-IL",
        )
      : undefined;

    if (!gcsUri) {
      return NextResponse.json(
        { error: "Falta gcsUri para iniciar el job." },
        { status: 400 },
      );
    }

    const job = await startTranscriptionJob({
      gcsUri,
      mimeType,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      selectedLanguages,
    });

    return NextResponse.json({ job });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo iniciar el job de transcripcion.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
