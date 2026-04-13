export type SupportedLanguage = "es-AR" | "en-US" | "iw-IL";

export type RecordingItem = {
  id: string;
  createdAt: string;

  // ── Session & user context (new) ─────────────────────────────────────────────
  /** Client-generated UUID grouping related transcriptions in one session. */
  session_id?: string;
  /** User ID from the existing authentication system (localStorage). */
  user_id?: string;

  // ── Audio sources ─────────────────────────────────────────────────────────────
  inputAudioUrl?: string;
  summaryAudioUrl?: string;
  summaryAudioDataUrl?: string;
  inputAudioStorageUri?: string;

  // ── Transcription ─────────────────────────────────────────────────────────────
  /**
   * Original transcript exactly as spoken — no translation applied.
   * May include inline language tags ([HE], [EN], [ES]) at boundaries.
   * New records populate both `original_text` and `transcript` (alias).
   */
  original_text?: string;
  /** @deprecated Prefer `original_text`. Kept for backward compatibility. */
  transcript: string;

  // ── AI response ───────────────────────────────────────────────────────────────
  /**
   * Structured AI response ALWAYS in Spanish, regardless of source language(s).
   * Format: context → key points → conclusions.
   */
  ai_response_es?: string;
  /** @deprecated Prefer `ai_response_es`. Kept for backward compatibility. */
  summary: string;

  // ── Translations ──────────────────────────────────────────────────────────────
  /**
   * Full transcript translated into each selected language by GPT.
   * Keys are SupportedLanguage codes; values are complete translations.
   * Example: { "es-AR": "...", "en-US": "...", "iw-IL": "..." }
   */
  translations?: Partial<Record<SupportedLanguage, string>>;

  // ── Language metadata ─────────────────────────────────────────────────────────
  detectedLanguage: SupportedLanguage | "unknown";
  detectedLanguages?: SupportedLanguage[];

  // ── Speaker metadata ──────────────────────────────────────────────────────────
  speakerCount?: number;
  speakerRoles?: string[];

  // ── Timing ────────────────────────────────────────────────────────────────────
  durationSeconds: number;
};
