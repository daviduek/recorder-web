import { randomUUID } from "node:crypto";

import { GoogleGenAI } from "@google/genai";
import speech from "@google-cloud/speech";
import { Storage } from "@google-cloud/storage";
import textToSpeech from "@google-cloud/text-to-speech";

import type { SupportedLanguage } from "@/lib/types";

const SPEECH_LANGUAGES: SupportedLanguage[] = ["es-AR", "en-US", "he-IL"];

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
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
const projectId =
  inlineCredentials?.project_id ?? process.env.GOOGLE_CLOUD_PROJECT;

const googleAuthOptions = inlineCredentials
  ? {
      projectId,
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
const storageClient = new Storage(googleAuthOptions);

function extensionFromMime(mimeType: string) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function speechEncodingFromMime(mimeType: string) {
  if (mimeType.includes("webm")) return "WEBM_OPUS";
  if (mimeType.includes("wav")) return "LINEAR16";
  if (mimeType.includes("ogg")) return "OGG_OPUS";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "MP3";
  return "ENCODING_UNSPECIFIED";
}

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
    return "he-IL";
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

async function ensureBucket() {
  const explicitBucket = process.env.GOOGLE_STORAGE_BUCKET?.trim();
  if (explicitBucket) {
    return explicitBucket;
  }

  let bucketName = explicitBucket;
  if (!bucketName) {
    if (!projectId) {
      throw new Error(
        "Falta GOOGLE_STORAGE_BUCKET (o project_id en credenciales) para procesar audios largos.",
      );
    }
    bucketName = `${projectId}-recorder-web-audio`;
  }

  const bucket = storageClient.bucket(bucketName);
  const [exists] = await bucket.exists();

  if (!exists) {
    if (!projectId) {
      throw new Error(
        "No se pudo crear el bucket automaticamente porque falta project_id.",
      );
    }

    await storageClient.createBucket(bucketName, {
      location: process.env.GOOGLE_STORAGE_LOCATION ?? "US",
      uniformBucketLevelAccess: true,
    });
  }

  return bucketName;
}

export async function createSignedUploadTarget(mimeType: string) {
  const bucketName = await ensureBucket();
  const id = randomUUID();
  const fileName = `recordings/${id}.${extensionFromMime(mimeType)}`;
  const file = storageClient.bucket(bucketName).file(fileName);

  const [uploadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 15 * 60 * 1000,
    contentType: mimeType,
  });

  const [downloadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  return {
    gcsUri: `gs://${bucketName}/${fileName}`,
    uploadUrl,
    downloadUrl,
  };
}

export async function transcribeFromGcs(
  gcsUri: string,
  mimeType: string,
): Promise<{ transcript: string; detectedLanguage: SupportedLanguage | "unknown" }> {
  const [operation] = await speechClient.longRunningRecognize({
    config: {
      languageCode: SPEECH_LANGUAGES[0],
      alternativeLanguageCodes: SPEECH_LANGUAGES.slice(1),
      enableAutomaticPunctuation: true,
      encoding: speechEncodingFromMime(mimeType),
    },
    audio: {
      uri: gcsUri,
    },
  });

  const [response] = await operation.promise();
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
