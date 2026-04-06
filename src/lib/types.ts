export type SupportedLanguage = "es-AR" | "en-US" | "he-IL";

export type RecordingItem = {
  id: string;
  createdAt: string;
  inputAudioUrl?: string;
  summaryAudioUrl?: string;
  summaryAudioDataUrl?: string;
  inputAudioStorageUri?: string;
  transcript: string;
  summary: string;
  detectedLanguage: SupportedLanguage | "unknown";
  durationSeconds: number;
};
