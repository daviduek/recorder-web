import { NextResponse } from "next/server";

import {
  buildSummaryAudio,
  pollTranscriptionJob,
  summarizeTranscript,
  type TranscriptionJob,
} from "@/lib/google-pipeline";
import { addLanguageTags } from "@/lib/language-detection";
import { generateSpanishResponse } from "@/lib/ai-response";

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

    const rawTranscript = status.transcript?.trim() ?? "";
    if (!rawTranscript) {
      return NextResponse.json(
        {
          error:
            "El audio se proceso pero no se detecto voz suficiente para transcribir. Reintenta con mayor volumen o menos ruido.",
        },
        { status: 422 },
      );
    }

    const detectedLanguage = status.detectedLanguage ?? "unknown";

    // ── Language tagging ───────────────────────────────────────────────────────
    // Inserta [HE] / [EN] / [ES] en los puntos donde cambia el idioma.
    // Cae gracefully al transcript crudo si el servicio de IA no está disponible.
    const transcript = await addLanguageTags(rawTranscript);

    // ── Text responses — en paralelo para reducir latencia ────────────────────
    const [summary, ai_response_es] = await Promise.all([
      summarizeTranscript(transcript), // backward-compat, siempre en español
      generateSpanishResponse(transcript), // nuevo campo explícito
    ]);

    // ── TTS (opcional) ────────────────────────────────────────────────────────
    // Google Cloud TTS requiere billing habilitado. Si falla, se omite el audio
    // del resumen sin romper la respuesta (la transcripción sigue siendo válida).
    let summaryAudioDataUrl = "";
    try {
      const audioBuffer = await buildSummaryAudio(summary, detectedLanguage);
      summaryAudioDataUrl = `data:audio/mpeg;base64,${audioBuffer.toString("base64")}`;
    } catch (ttsError) {
      const msg = ttsError instanceof Error ? ttsError.message : String(ttsError);
      console.warn("[status] Google TTS no disponible, omitiendo audio:", msg);
    }

    return NextResponse.json({
      done: true,
      progress: 100,
      // ── Transcripción ──────────────────────────────────────────────────────
      transcript,             // con language tags, backward compat
      original_text: transcript, // campo nuevo explícito
      // ── Respuestas IA ──────────────────────────────────────────────────────
      summary,                // backward compat (siempre español)
      ai_response_es,         // nuevo: formato estructurado, siempre español
      // ── Audio ──────────────────────────────────────────────────────────────
      summaryAudioDataUrl,    // vacío si Google TTS no está disponible
      // ── Metadata ───────────────────────────────────────────────────────────
      detectedLanguage,
      detectedLanguages: status.detectedLanguages ?? [],
      speakerCount: status.speakerCount ?? 1,
      speakerRoles: status.speakerRoles ?? [],
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo consultar el estado del job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
