import { randomUUID } from "node:crypto";

import { GoogleGenAI } from "@google/genai";
import speech from "@google-cloud/speech";
import { Storage } from "@google-cloud/storage";
import textToSpeech from "@google-cloud/text-to-speech";

import type { SupportedLanguage } from "@/lib/types";

const HEBREW_PHRASES = [
  "שלום",
  "תודה",
  "בוקר טוב",
  "ערב טוב",
  "מה נשמע",
  "בסדר",
  "אני צריך",
  "אני רוצה",
  "כן",
  "לא",
];

const MIXED_CONTEXT_PHRASES = [
  "context",
  "summary",
  "producto",
  "proyecto",
  "integracion",
  "meeting",
  "roadmap",
  "shalom",
  "todah",
  ...HEBREW_PHRASES,
];

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

export type PassSource = "auto" | "es" | "en" | "he";

export type TranscriptionJobOperation = {
  source: PassSource;
  operationName: string;
};

export type TranscriptionJob = {
  operations: TranscriptionJobOperation[];
  mimeType: string;
};

type TranscriptionCandidate = {
  source: PassSource;
  transcript: string;
  detectedLanguage: SupportedLanguage | "unknown";
  averageConfidence: number;
  speakerCount: number;
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

function speechEncodingCandidatesFromMime(mimeType: string) {
  if (mimeType.includes("webm")) return ["WEBM_OPUS", "ENCODING_UNSPECIFIED"] as const;
  if (mimeType.includes("wav")) return ["LINEAR16"] as const;
  if (mimeType.includes("ogg")) return ["OGG_OPUS", "ENCODING_UNSPECIFIED"] as const;
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ["MP3"] as const;
  return ["ENCODING_UNSPECIFIED"] as const;
}

function normalizeLanguageCode(language: string): "es-AR" | "en-US" | "he-IL" {
  if (language.startsWith("en")) return "en-US";
  if (language.startsWith("iw") || language.startsWith("he")) return "he-IL";
  return "es-AR";
}

function toSupportedLanguage(language: string): SupportedLanguage | "unknown" {
  if (language.startsWith("en")) return "en-US";
  if (language.startsWith("iw") || language.startsWith("he")) return "iw-IL";
  if (language.startsWith("es")) return "es-AR";
  return "unknown";
}

function hasHebrewCharacters(text: string) {
  return /[\u0590-\u05FF]/.test(text);
}

function inferLanguageFromTranscript(
  transcript: string,
  detectedFromApi: string,
): SupportedLanguage | "unknown" {
  if (hasHebrewCharacters(transcript)) return "iw-IL";
  return toSupportedLanguage(detectedFromApi);
}

function summarizeFallback(transcript: string) {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return "No se pudo generar resumen porque la transcripcion quedo vacia.";
  }
  return `Resumen rapido: ${trimmed.slice(0, 600)}${trimmed.length > 600 ? "..." : ""}`;
}

function getAverageConfidence(
  results: Array<{ alternatives?: Array<{ confidence?: number | null }> | null }> = [],
) {
  const confidences = results
    .map((result) => result.alternatives?.[0]?.confidence)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (confidences.length === 0) return 0;
  return confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
}

function scoreCandidate(candidate: TranscriptionCandidate) {
  const transcript = candidate.transcript.trim();
  if (!transcript) return -1_000;

  let score = transcript.length * 0.03 + candidate.averageConfidence * 100;
  if (hasHebrewCharacters(transcript)) score += 35;
  if (candidate.detectedLanguage === "iw-IL") score += 20;
  if (candidate.source === "he" && hasHebrewCharacters(transcript)) score += 15;
  if (candidate.speakerCount > 1) score += Math.min(10, candidate.speakerCount * 2);
  return score;
}

function buildTranscriptWithSpeakers(
  results: Array<{
    alternatives?: Array<{
      transcript?: string | null;
      words?: Array<{ word?: string | null; speakerTag?: number | null }> | null;
    }> | null;
  }>,
) {
  const fallback = results
    .map((result) => result.alternatives?.[0]?.transcript?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();

  const words = results
    .flatMap((result) => result.alternatives?.[0]?.words ?? [])
    .filter(Boolean) as Array<{ word?: string | null; speakerTag?: number | null }>;

  if (words.length === 0) {
    return { transcript: fallback, speakerCount: 1 };
  }

  const chunks: Array<{ speaker: number; text: string[] }> = [];
  const uniqueSpeakers = new Set<number>();

  for (const token of words) {
    const rawWord = token.word?.trim();
    if (!rawWord) continue;
    const speaker = Math.max(1, Math.min(3, Number(token.speakerTag ?? 1)));
    uniqueSpeakers.add(speaker);

    const last = chunks[chunks.length - 1];
    if (!last || last.speaker !== speaker) {
      chunks.push({ speaker, text: [rawWord] });
    } else {
      last.text.push(rawWord);
    }
  }

  const diarized = chunks
    .map((chunk) => `[S${chunk.speaker}] ${chunk.text.join(" ").trim()}`)
    .join("\n")
    .trim();

  if (
    fallback.length > 0 &&
    (diarized.length < Math.round(fallback.length * 0.6) || chunks.length <= 1)
  ) {
    return {
      transcript: fallback,
      speakerCount: Math.max(1, Math.min(3, uniqueSpeakers.size || 1)),
    };
  }

  return {
    transcript: diarized,
    speakerCount: Math.max(1, Math.min(3, uniqueSpeakers.size)),
  };
}

function passConfig(source: PassSource): {
  primaryLanguage: SupportedLanguage;
  alternativeLanguages: SupportedLanguage[];
} {
  if (source === "es") return { primaryLanguage: "es-AR", alternativeLanguages: [] };
  if (source === "en") return { primaryLanguage: "en-US", alternativeLanguages: [] };
  if (source === "he") return { primaryLanguage: "iw-IL", alternativeLanguages: [] };
  return {
    primaryLanguage: "es-AR",
    alternativeLanguages: ["en-US", "iw-IL"],
  };
}

function selectPassSources(): PassSource[] {
  return ["auto", "es", "en", "he"];
}

async function ensureBucket() {
  const explicitBucket = process.env.GOOGLE_STORAGE_BUCKET?.trim();
  if (explicitBucket) return explicitBucket;

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

async function startSinglePassOperation(
  source: PassSource,
  gcsUri: string,
  mimeType: string,
) {
  const config = passConfig(source);
  const encodingCandidates = speechEncodingCandidatesFromMime(mimeType);
  let lastError: unknown = null;

  for (const encoding of encodingCandidates) {
    const sampleRateAttempts =
      encoding === "OGG_OPUS" || encoding === "WEBM_OPUS"
        ? [48000, 24000, 16000, 12000, 8000, undefined]
        : [undefined];

    for (const sampleRate of sampleRateAttempts) {
      try {
        const [operation] = await speechClient.longRunningRecognize({
          config: {
            languageCode: config.primaryLanguage,
            alternativeLanguageCodes: config.alternativeLanguages,
            enableAutomaticPunctuation: true,
            speechContexts: [
              { phrases: MIXED_CONTEXT_PHRASES },
              { phrases: HEBREW_PHRASES },
            ],
            diarizationConfig: {
              enableSpeakerDiarization: true,
              minSpeakerCount: 1,
              maxSpeakerCount: 3,
            },
            enableWordTimeOffsets: true,
            encoding,
            ...(typeof sampleRate === "number" ? { sampleRateHertz: sampleRate } : {}),
          },
          audio: { uri: gcsUri },
        });

        const name = operation.latestResponse?.name;
        if (!name) {
          throw new Error("No se pudo iniciar la operacion de transcripcion.");
        }

        return {
          source,
          operationName: name,
        } satisfies TranscriptionJobOperation;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("No se pudo iniciar la operacion de transcripcion.");
}

export async function startTranscriptionJob(params: {
  gcsUri: string;
  mimeType: string;
  durationSeconds: number;
}): Promise<TranscriptionJob> {
  const sources = selectPassSources();
  const operations = await Promise.all(
    sources.map((source) =>
      startSinglePassOperation(source, params.gcsUri, params.mimeType),
    ),
  );

  return {
    operations,
    mimeType: params.mimeType,
  };
}

function candidateFromResponse(
  source: PassSource,
  response: {
    results?: Array<{
      languageCode?: string | null;
      alternatives?: Array<{
        transcript?: string | null;
        confidence?: number | null;
        words?: Array<{ word?: string | null; speakerTag?: number | null }> | null;
      }> | null;
    }> | null;
  },
): TranscriptionCandidate {
  const results = response.results ?? [];
  const speakerAware = buildTranscriptWithSpeakers(results);
  const detectedFromResult = response.results?.[0]?.languageCode ?? "";

  return {
    source,
    transcript: speakerAware.transcript,
    detectedLanguage: inferLanguageFromTranscript(
      speakerAware.transcript,
      detectedFromResult,
    ),
    averageConfidence: getAverageConfidence(results),
    speakerCount: speakerAware.speakerCount,
  };
}

function simpleFusion(candidates: TranscriptionCandidate[]) {
  const ordered = [...candidates].sort(
    (a, b) => scoreCandidate(b) - scoreCandidate(a),
  );
  return ordered[0];
}

async function fuseCandidatesWithLLM(candidates: TranscriptionCandidate[]) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return simpleFusion(candidates);

  try {
    const ai = new GoogleGenAI({ apiKey });
    const payload = candidates.map((candidate) => ({
      source: candidate.source,
      language: candidate.detectedLanguage,
      confidence: Number(candidate.averageConfidence.toFixed(4)),
      speakerCount: candidate.speakerCount,
      transcript: candidate.transcript,
    }));

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Sos un fusionador experto de ASR multilingue (espanol, ingles, hebreo).",
                "Te paso hipotesis del mismo audio.",
                "Objetivo: devolver la mejor transcripcion final, respetando mezcla de idiomas y hablantes.",
                "Reglas:",
                "1) No inventar contenido.",
                "2) Priorizar hipotesis con mejor sentido global.",
                "3) Si una palabra corta hebrea aparece en hipotesis he y es coherente, conservarla.",
                "4) Mantener hebreo en caracteres hebreos.",
                "5) Mantener etiquetas de hablante [S1],[S2],[S3].",
                "6) No resumir.",
                "",
                "Devolver JSON estricto:",
                '{"chosenSource":"auto|es|en|he","transcript":"...","detectedLanguage":"es-AR|en-US|iw-IL|unknown","speakerCount":1}',
                "",
                "HIPOTESIS:",
                JSON.stringify(payload),
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0.1 },
    });

    const raw = response.text?.trim();
    if (!raw) return simpleFusion(candidates);

    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      chosenSource?: PassSource;
      transcript?: string;
      detectedLanguage?: SupportedLanguage | "unknown";
      speakerCount?: number;
    };

    const picked = candidates.find((candidate) => candidate.source === parsed.chosenSource);
    const transcript = parsed.transcript?.trim();
    if (!picked || !transcript) return simpleFusion(candidates);

    return {
      ...picked,
      transcript,
      detectedLanguage: parsed.detectedLanguage ?? picked.detectedLanguage,
      speakerCount: Math.max(
        1,
        Math.min(3, Math.round(parsed.speakerCount ?? picked.speakerCount)),
      ),
    };
  } catch {
    return simpleFusion(candidates);
  }
}

async function improveTranscriptForReadability(
  transcript: string,
  detectedLanguage: SupportedLanguage | "unknown",
) {
  const input = transcript.trim();
  if (!input) return input;

  if (input.length > 18_000) {
    return input;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return input;

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
                "Mejora esta transcripcion ASR sin inventar informacion.",
                "Reglas:",
                "1) Mantener todo el contenido original.",
                "2) Corregir puntuacion, mayusculas y segmentacion en frases.",
                "3) Conservar palabras y frases en su idioma original (espanol, ingles, hebreo).",
                "4) Si hay hebreo, mantenerlo en caracteres hebreos (no transliterar).",
                "5) Respetar etiquetas de hablante [S1], [S2], [S3].",
                "6) Resolver frases poco claras usando el contexto de frases cercanas, sin inventar hechos nuevos.",
                "7) No resumir ni agregar datos.",
                "",
                `Idioma detectado aproximado: ${detectedLanguage}`,
                "",
                "Devuelve solo el texto final mejorado.",
                "",
                "TRANSCRIPCION CRUDA:",
                input,
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0.1 },
    });

    const output = response.text?.trim();
    return output && output.length > 0 ? output : input;
  } catch {
    return input;
  }
}

async function inferSpeakerRoles(transcript: string, speakerCount: number) {
  const normalizedSpeakerCount = Math.max(1, Math.min(3, speakerCount));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !transcript.includes("[S")) {
    return {
      transcript,
      speakerCount: normalizedSpeakerCount,
      roles: Array.from({ length: normalizedSpeakerCount }, (_, i) => `S${i + 1}`),
    };
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
                "Dado este transcript diarizado con etiquetas [S1], [S2], [S3], inferi roles contextuales.",
                "Roles validos: ORADOR, PUBLICO, PARTICIPANTE_3.",
                "Reglas:",
                "1) No inventar contenido.",
                "2) Mantener exactamente el texto original; solo reemplazar etiquetas Sx por rol.",
                "3) Si hay duda, dejar ORADOR/PUBLICO por orden de predominio.",
                "",
                `Cantidad de hablantes esperada: ${normalizedSpeakerCount}`,
                "",
                "Devolver JSON estricto:",
                '{"transcript":"...","roles":["ORADOR","PUBLICO"]}',
                "",
                "TRANSCRIPT:",
                transcript,
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0.1 },
    });

    const raw = response.text?.trim();
    if (!raw) {
      return {
        transcript,
        speakerCount: normalizedSpeakerCount,
        roles: Array.from({ length: normalizedSpeakerCount }, (_, i) => `S${i + 1}`),
      };
    }

    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { transcript?: string; roles?: string[] };
    return {
      transcript: parsed.transcript?.trim() || transcript,
      speakerCount: normalizedSpeakerCount,
      roles:
        parsed.roles && parsed.roles.length > 0
          ? parsed.roles.slice(0, 3)
          : Array.from({ length: normalizedSpeakerCount }, (_, i) => `S${i + 1}`),
    };
  } catch {
    return {
      transcript,
      speakerCount: normalizedSpeakerCount,
      roles: Array.from({ length: normalizedSpeakerCount }, (_, i) => `S${i + 1}`),
    };
  }
}

async function inferDetectedLanguages(
  transcript: string,
  candidates: TranscriptionCandidate[],
) {
  const detected = new Set<SupportedLanguage>();
  for (const candidate of candidates) {
    if (candidate.detectedLanguage !== "unknown") {
      detected.add(candidate.detectedLanguage);
    }
  }
  if (hasHebrewCharacters(transcript)) detected.add("iw-IL");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || transcript.trim().length === 0) {
    return [...detected];
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
                "Detecta idiomas presentes en esta transcripcion.",
                "Idiomas permitidos: es-AR, en-US, iw-IL.",
                "Devuelve JSON estricto con array de codigos.",
                'Formato: {"languages":["es-AR","en-US"]}',
                "",
                "TRANSCRIPCION:",
                transcript.slice(0, 12000),
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0 },
    });

    const raw = response.text?.trim();
    if (raw) {
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned) as { languages?: string[] };
      for (const language of parsed.languages ?? []) {
        if (language === "es-AR" || language === "en-US" || language === "iw-IL") {
          detected.add(language);
        }
      }
    }
  } catch {
    // keep best-effort detected set
  }

  return [...detected];
}

export async function pollTranscriptionJob(job: TranscriptionJob): Promise<{
  done: boolean;
  progress: number;
  transcript?: string;
  detectedLanguage?: SupportedLanguage | "unknown";
  detectedLanguages?: SupportedLanguage[];
  speakerCount?: number;
  speakerRoles?: string[];
}> {
  const candidates: TranscriptionCandidate[] = [];
  let completed = 0;

  for (const operationInfo of job.operations) {
    const operation = await speechClient.checkLongRunningRecognizeProgress(
      operationInfo.operationName,
    );
    const isDone = Boolean(operation.latestResponse?.done);

    if (!isDone) {
      continue;
    }

    const [response] = await operation.promise();
    candidates.push(
      candidateFromResponse(operationInfo.source, response as Parameters<typeof candidateFromResponse>[1]),
    );
    completed += 1;
  }

  if (completed < job.operations.length) {
    return {
      done: false,
      progress: Math.max(
        5,
        Math.min(95, Math.round((completed / job.operations.length) * 88 + 5)),
      ),
    };
  }

  const fused = await fuseCandidatesWithLLM(candidates);
  const polished = await improveTranscriptForReadability(
    fused.transcript,
    fused.detectedLanguage,
  );
  const roles = await inferSpeakerRoles(polished, fused.speakerCount);
  const detectedLanguages = await inferDetectedLanguages(roles.transcript, candidates);
  const primaryLanguage =
    fused.detectedLanguage !== "unknown"
      ? fused.detectedLanguage
      : detectedLanguages[0] ?? "unknown";

  return {
    done: true,
    progress: 100,
    transcript: roles.transcript,
    detectedLanguage: primaryLanguage,
    detectedLanguages,
    speakerCount: roles.speakerCount,
    speakerRoles: roles.roles,
  };
}

export async function summarizeTranscript(transcript: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return summarizeFallback(transcript);

  try {
    const ai = new GoogleGenAI({ apiKey });
    const source =
      transcript.length > 30_000 ? transcript.slice(0, 30_000) : transcript;

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
                source,
              ].join("\n"),
            },
          ],
        },
      ],
      config: { temperature: 0.2 },
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
