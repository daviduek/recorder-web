export type SupportedLanguage = "es-AR" | "en-US" | "iw-IL";

export type RecordingItem = {
  id: string;
  createdAt: string;
  inputAudioUrl?: string;
  summaryAudioUrl?: string;
  inputAudioDataUrl?: string;
  summaryAudioDataUrl?: string;
  transcript: string;
  summary: string;
  detectedLanguage: SupportedLanguage | "unknown";
  durationSeconds: number;
};
