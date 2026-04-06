import { GoogleGenAI } from "@google/genai";
import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";

import type { SupportedLanguage } from "@/lib/types";

const SPEECH_LANGUAGES: SupportedLanguage[] = ["es-AR", "en-US", "iw-IL"];

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
};

function parseInlineCredentials(): GoogleServiceAccount | null {
  const inline = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!inline) return null;

  try {
    if (inline.trim().startsWith("{")) {
      return JSON.parse(inline) as GoogleServiceAccount;
    }

    const decoded = Buffer.from(inline, "base64").toString("utf-8");
    return JSON.parse(decoded) as GoogleServiceAccount;
  } catch {
    return null;
  }
}

const inlineCredentials = parseInlineCredentials();
const googleAuthOptions = inlineCredentials
  ? {
      credentials: {
        client_email: inlineCredentials.client_email,
        private_key: inlineCredentials.private_key,
      },
    }
  : {};

const speechClient = new speech.SpeechClient(googleAuthOptions);
const textToSpeechClient = new textToSpeech.TextToSpeechClient(
  googleAuthOptions,
);

function normalizeLanguageCode(language: string): "es-AR" | "en-US" | "he-IL" {
  if (language.startsWith("en")) {
    return "en-US";
  }
  if (language.startsWith("iw") || language.startsWith("he")) {
    return "he-IL";
  }
  return "es-AR";
}

function toSupportedLanguage(language: string): SupportedLanguage | "unknown" {
  if (language.startsWith("en")) {
    return "en-US";
  }
  if (language.startsWith("iw") || language.startsWith("he")) {
    return "iw-IL";
  }
  if (language.startsWith("es")) {
    return "es-AR";
  }
  return "unknown";
}

function summarizeFallback(transcript: string) {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return "No se pudo generar resumen porque la transcripcion quedo vacia.";
  }

  return `Resumen rapido: ${trimmed.slice(0, 600)}${trimmed.length > 600 ? "..." : ""}`;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<{ transcript: string; detectedLanguage: SupportedLanguage | "unknown" }> {
  const [response] = await speechClient.recognize({
    config: {
      languageCode: SPEECH_LANGUAGES[0],
      alternativeLanguageCodes: SPEECH_LANGUAGES.slice(1),
      enableAutomaticPunctuation: true,
      encoding: mimeType.includes("webm")
        ? "WEBM_OPUS"
        : mimeType.includes("wav")
          ? "LINEAR16"
          : "ENCODING_UNSPECIFIED",
    },
    audio: {
      content: audioBuffer.toString("base64"),
    },
  });

  const lines =
    response.results
      ?.map((result) => result.alternatives?.[0]?.transcript?.trim() ?? "")
      .filter(Boolean) ?? [];

  const transcript = lines.join(" ").trim();
  const detectedFromResult = response.results?.[0]?.languageCode ?? "";

  return {
    transcript,
    detectedLanguage: toSupportedLanguage(detectedFromResult),
  };
}

export async function summarizeTranscript(transcript: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return summarizeFallback(transcript);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Sos un asistente que resume audios multilingues.",
                "Detecta el idioma principal entre espanol, ingles y hebreo.",
                "Devuelve un resumen en espanol, claro y accionable, maximo 8 lineas.",
                "",
                "TRANSCRIPCION:",
                transcript,
              ].join("\n"),
            },
          ],
        },
      ],
      config: {
        temperature: 0.2,
      },
    });

    const text = response.text?.trim();
    return text && text.length > 0 ? text : summarizeFallback(transcript);
  } catch {
    return summarizeFallback(transcript);
  }
}

export async function buildSummaryAudio(
  summary: string,
  detectedLanguage: SupportedLanguage | "unknown",
) {
  const preferred = detectedLanguage === "unknown" ? "es-AR" : detectedLanguage;
  const ttsLanguage = normalizeLanguageCode(preferred);

  const [response] = await textToSpeechClient.synthesizeSpeech({
    input: { text: summary },
    voice: {
      languageCode: ttsLanguage,
      ssmlGender: "NEUTRAL",
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: 1,
    },
  });

  if (!response.audioContent) {
    throw new Error("Google TTS no devolvio audio para el resumen.");
  }

  const data =
    response.audioContent instanceof Uint8Array
      ? response.audioContent
      : Buffer.from(response.audioContent as string, "base64");

  return Buffer.from(data);
}
