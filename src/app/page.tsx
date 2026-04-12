"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RecordingItem } from "@/lib/types";

const USERS_STORAGE_KEY = "recorder-web-users";
const SESSION_STORAGE_KEY = "recorder-web-session";
const MAX_RECORDING_SECONDS = 1200;

type TranscriptionJob = {
  operations: Array<{ source: "auto" | "es" | "en" | "he"; operationName: string }>;
  mimeType: string;
};

type AppUser = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
};

const AUDIO_EXTENSIONS = ["webm", "wav", "mp3", "ogg", "m4a", "aac", "flac"];

function languageLabel(code: RecordingItem["detectedLanguage"]) {
  if (code === "en-US") return "Ingles";
  if (code === "iw-IL") return "Hebreo";
  if (code === "es-AR") return "Espanol";
  return "Sin detectar";
}

function formatEta(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const remaining = Math.floor(safe % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function userHistoryKey(userId: string) {
  return `recorder-web-history:${userId}`;
}

function inferMimeTypeFromName(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "";
}

function isAudioFile(file: File) {
  if (file.type.startsWith("audio/")) return true;
  const lower = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}

async function hashPassword(password: string) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const data = new TextEncoder().encode(password);
      const digest = await subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fallback below
  }

  let hash = 0;
  for (let index = 0; index < password.length; index += 1) {
    hash = (hash << 5) - hash + password.charCodeAt(index);
    hash |= 0;
  }
  return `fallback-${Math.abs(hash)}`;
}

function readUsers(): AppUser[] {
  const raw = localStorage.getItem(USERS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AppUser[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUsers(users: AppUser[]) {
  localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
}

export default function Home() {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(0);
  const [processingStep, setProcessingStep] = useState("");
  const [etaSeconds, setEtaSeconds] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);

  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const autoStoppingRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);
  const processingStartedAtRef = useRef<number>(0);
  const estimatedTotalSecondsRef = useRef<number>(0);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      try {
        const user = JSON.parse(raw) as AppUser;
        setCurrentUser(user);
      } catch {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
    setLoading(false);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (progressTimerRef.current) window.clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      setItems([]);
      return;
    }
    void loadRecordings(currentUser);
  }, [currentUser]);

  function stopProgressTimer() {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }

  function setStep(step: string, minimumProgress: number) {
    setProcessingStep(step);
    setProgress((current) => Math.max(current, minimumProgress));
  }

  function startProgressTracking(durationSeconds: number) {
    stopProgressTimer();
    const estimated = Math.max(
      45,
      Math.min(70 * 60, Math.round(durationSeconds * 0.9 + 120)),
    );
    estimatedTotalSecondsRef.current = estimated;
    processingStartedAtRef.current = Date.now();
    setProgress(6);
    setEtaSeconds(estimated);
    setProcessingStep("Preparando carga de audio...");

    progressTimerRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - processingStartedAtRef.current) / 1000);
      const remaining = Math.max(0, estimatedTotalSecondsRef.current - elapsed);
      setEtaSeconds(remaining);

      setProgress((current) => {
        if (current >= 93) return current;
        const smoothJump = Math.max(0.18, 15 / Math.max(estimatedTotalSecondsRef.current, 1));
        return Math.min(93, current + smoothJump);
      });
    }, 1000);
  }

  async function loadRecordings(user: AppUser) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/recordings", { cache: "no-store" });
      const data = (await response.json()) as { recordings: RecordingItem[] };
      const apiRecordings = data.recordings ?? [];

      if (apiRecordings.length > 0) {
        setItems(apiRecordings);
      } else {
        const local = localStorage.getItem(userHistoryKey(user.id));
        setItems(local ? (JSON.parse(local) as RecordingItem[]) : []);
      }
    } catch {
      const local = localStorage.getItem(userHistoryKey(user.id));
      setItems(local ? (JSON.parse(local) as RecordingItem[]) : []);
    } finally {
      setLoading(false);
    }
  }

  async function createAccount() {
    try {
      setAuthError("");
      if (!authEmail.trim() || authPassword.length < 6) {
        setAuthError("Completa email y clave (minimo 6 caracteres).");
        return;
      }

      const users = readUsers();
      const normalizedEmail = authEmail.trim().toLowerCase();
      if (users.some((user) => user.email === normalizedEmail)) {
        setAuthError("Ese email ya esta registrado. Usa Ingresar.");
        return;
      }

      const userId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;

      const newUser: AppUser = {
        id: userId,
        name: normalizedEmail.split("@")[0] || "usuario",
        email: normalizedEmail,
        passwordHash: await hashPassword(authPassword),
      };

      users.push(newUser);
      saveUsers(users);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newUser));
      setCurrentUser(newUser);
      setAuthEmail("");
      setAuthPassword("");
    } catch {
      setAuthError(
        "No se pudo completar el registro en este navegador. Reintenta.",
      );
    }
  }

  async function login() {
    try {
      setAuthError("");
      const users = readUsers();
      const normalizedEmail = authEmail.trim().toLowerCase();
      const hash = await hashPassword(authPassword);
      const user = users.find(
        (entry) =>
          entry.email === normalizedEmail && entry.passwordHash === hash,
      );

      if (!user) {
        setAuthError("Credenciales invalidas.");
        return;
      }

      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
      setCurrentUser(user);
      setAuthEmail("");
      setAuthPassword("");
    } catch {
      setAuthError("No se pudo iniciar sesion. Reintenta.");
    }
  }

  function logout() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setCurrentUser(null);
    setItems([]);
    setSelectedFile(null);
    setError("");
  }

  function persistUserRecordings(user: AppUser, recordings: RecordingItem[]) {
    localStorage.setItem(userHistoryKey(user.id), JSON.stringify(recordings));
  }

  async function startRecording() {
    if (!currentUser) return;
    setError("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    mediaRecorder.start();
    setRecording(true);
    setSeconds(0);
    autoStoppingRef.current = false;

    timerRef.current = window.setInterval(() => {
      setSeconds((current) => {
        const next = current + 1;
        if (next >= MAX_RECORDING_SECONDS && !autoStoppingRef.current) {
          autoStoppingRef.current = true;
          window.setTimeout(() => {
            void stopRecording();
          }, 0);
        }
        return next;
      });
    }, 1000);
  }

  async function stopRecording() {
    if (!currentUser || !recorderRef.current) return;

    await new Promise<void>((resolve) => {
      if (!recorderRef.current) {
        resolve();
        return;
      }
      recorderRef.current.onstop = () => resolve();
      recorderRef.current.stop();
    });

    if (timerRef.current) window.clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());

    setRecording(false);
    autoStoppingRef.current = false;

    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    await processAudioBlob(blob, seconds, `recording-${Date.now()}.webm`);
    setSeconds(0);
  }

  async function processAudioBlob(
    blob: Blob,
    durationSeconds: number,
    filename: string,
    mimeTypeOverride?: string,
  ) {
    if (!currentUser) return;

    setProcessing(true);
    setError("");
    startProgressTracking(durationSeconds);

    try {
      setStep("Solicitando URL segura de carga...", 12);
      const prepResponse = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mimeType: mimeTypeOverride || blob.type || "audio/webm",
        }),
      });
      const prepData = (await prepResponse.json()) as {
        error?: string;
        gcsUri?: string;
        uploadUrl?: string;
        downloadUrl?: string;
        mimeType?: string;
      };

      if (
        !prepResponse.ok ||
        !prepData.gcsUri ||
        !prepData.uploadUrl ||
        !prepData.mimeType
      ) {
        throw new Error(prepData.error ?? "No se pudo preparar la subida del audio.");
      }

      setStep("Subiendo audio a la nube...", 24);
      const uploadResponse = await fetch(prepData.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": prepData.mimeType,
          "x-goog-meta-filename": encodeURIComponent(filename),
        },
        body: blob,
      });
      if (!uploadResponse.ok) {
        throw new Error("Fallo la subida del audio a Google Cloud Storage.");
      }

      setStep("Iniciando transcripcion de larga duracion...", 34);
      const startResponse = await fetch("/api/transcription-jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gcsUri: prepData.gcsUri,
          mimeType: prepData.mimeType,
          durationSeconds,
        }),
      });
      const startData = (await startResponse.json()) as {
        error?: string;
        job?: TranscriptionJob;
      };
      if (!startResponse.ok || !startData.job) {
        throw new Error(startData.error ?? "No se pudo iniciar el procesamiento.");
      }

      let done = false;
      let lastStatus: {
        transcript?: string;
        detectedLanguage?: RecordingItem["detectedLanguage"];
        speakerCount?: number;
        speakerRoles?: string[];
        summary?: string;
        summaryAudioDataUrl?: string;
        progress?: number;
      } = {};

      while (!done) {
        await new Promise((resolve) => window.setTimeout(resolve, 3500));
        const statusResponse = await fetch("/api/transcription-jobs/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job: startData.job }),
        });
        const statusData = (await statusResponse.json()) as {
          error?: string;
          done?: boolean;
          progress?: number;
          transcript?: string;
          detectedLanguage?: RecordingItem["detectedLanguage"];
          speakerCount?: number;
          speakerRoles?: string[];
          summary?: string;
          summaryAudioDataUrl?: string;
        };

        if (!statusResponse.ok) {
          throw new Error(statusData.error ?? "Error consultando estado del procesamiento.");
        }

        if (!statusData.done) {
          setStep("Transcribiendo (multi-idioma y hablantes)...", 40);
          if (typeof statusData.progress === "number") {
            const remoteProgress = statusData.progress;
            setProgress((current) => Math.max(current, remoteProgress));
          }
          continue;
        }

        done = true;
        lastStatus = statusData;
      }

      if (!lastStatus.transcript || !lastStatus.summary) {
        throw new Error("Finalizo sin transcript/summary. Reintenta con otro audio.");
      }

      setStep("Guardando registro final...", 98);
      const saveResponse = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputAudioUrl: prepData.downloadUrl,
          inputAudioStorageUri: prepData.gcsUri,
          transcript: lastStatus.transcript,
          summary: lastStatus.summary,
          summaryAudioDataUrl: lastStatus.summaryAudioDataUrl,
          detectedLanguage: lastStatus.detectedLanguage,
          durationSeconds,
          speakerCount: lastStatus.speakerCount,
          speakerRoles: lastStatus.speakerRoles,
        }),
      });
      const saveData = (await saveResponse.json()) as {
        error?: string;
        recording?: RecordingItem;
      };

      if (!saveResponse.ok || !saveData.recording) {
        throw new Error(saveData.error ?? "No se pudo guardar la grabacion.");
      }

      setItems((previous) => {
        const next = [saveData.recording as RecordingItem, ...previous];
        persistUserRecordings(currentUser, next);
        return next;
      });

      setProgress(100);
      setEtaSeconds(0);
      setProcessingStep("Completado.");
      setSelectedFile(null);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "No se pudo completar el proceso.";
      setError(
        message === "Failed to fetch"
          ? "Fallo de red/CORS al subir audio. Si persiste, revisamos permisos del bucket de Google Cloud."
          : message,
      );
      setProgress(0);
      setProcessingStep("");
    } finally {
      stopProgressTimer();
      setProcessing(false);
    }
  }

  async function uploadSelectedFile() {
    if (!selectedFile) {
      setError("Selecciona o arrastra un archivo de audio primero.");
      return;
    }

    if (!isAudioFile(selectedFile)) {
      setError("El archivo debe ser de audio (webm, wav, mp3, ogg, m4a, aac, flac).");
      return;
    }

    const resolvedMimeType =
      selectedFile.type || inferMimeTypeFromName(selectedFile.name) || "audio/webm";
    const assumedSeconds = Math.max(60, Math.round(selectedFile.size / 24_000));
    await processAudioBlob(
      selectedFile,
      assumedSeconds,
      selectedFile.name,
      resolvedMimeType,
    );
  }

  const statusText = useMemo(() => {
    if (processing) return "Procesando audio, transcripcion, contexto y resumen...";
    if (recording) return `Grabando ${seconds}s`;
    return "Listo para grabar o subir archivo";
  }, [processing, recording, seconds]);

  const selectedFileLabel = useMemo(() => {
    if (!selectedFile) return "Ningun archivo seleccionado.";
    const mb = (selectedFile.size / (1024 * 1024)).toFixed(2);
    return `${selectedFile.name} (${mb} MB)`;
  }, [selectedFile]);

  if (!currentUser) {
    return (
      <div className="app-shell">
        <main className="studio">
          <header className="hero">
            <p className="eyebrow">Audio Journal</p>
            <h1>Accede con email y clave</h1>
            <p className="subtitle">
              Crea cuenta o inicia sesion. Cada usuario ve solo sus grabaciones.
            </p>
          </header>

          <section className="panel">
            <p className="panel-title">Acceso</p>
            <div className="auth-fields">
              <label className="auth-label">
                <span>Email</span>
                <input
                  className="auth-input"
                  type="email"
                  placeholder="tu@email.com"
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                />
              </label>
              <label className="auth-label">
                <span>Clave</span>
                <input
                  className="auth-input"
                  type="password"
                  placeholder="******"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
              </label>
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.8rem" }}>
              <button
                type="button"
                className="record-button"
                onClick={() => void createAccount()}
              >
                Crear cuenta
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void login()}
              >
                Ingresar
              </button>
            </div>
            {authError ? (
              <p className="error" style={{ marginTop: "0.8rem" }}>
                {authError}
              </p>
            ) : null}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="studio">
        <header className="hero">
          <p className="eyebrow">Audio Journal</p>
          <h1>Grabador multilenguaje con transcripcion y resumen hablado</h1>
          <p className="subtitle">
            Sesion activa: {currentUser.name} ({currentUser.email})
          </p>
          <button type="button" className="ghost" onClick={logout}>
            Cerrar sesion
          </button>
        </header>

        <section className="panel controls">
          <div>
            <p className="panel-title">Nueva grabacion</p>
            <p className="status">{statusText}</p>
            <p className="status">Grabacion en vivo: maximo automatico 20 minutos.</p>
            <p className="status">Subida de archivo: hasta 1 hora recomendada.</p>
          </div>
          <button
            type="button"
            className={`record-button ${recording ? "danger" : ""}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={processing}
          >
            {recording ? "Detener y procesar" : "Comenzar a grabar"}
          </button>
          {processing ? (
            <div className="progress-wrap">
              <div className="progress-head">
                <span>{processingStep || "Procesando..."}</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="progress-track" aria-hidden="true">
                <span
                  className="progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
              <p className="progress-meta">
                Tiempo estimado restante: {formatEta(etaSeconds)}
              </p>
            </div>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
        </section>

        <section className="panel controls">
          <div>
            <p className="panel-title">Subir archivo de audio</p>
            <p className="status">
              Formatos: webm, wav, mp3, ogg. Para 1 hora, recomendamos buena
              conexion y esperar la finalizacion del job.
            </p>
          </div>
          <div
            className={`upload-zone ${dragActive ? "active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!processing) setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              if (processing) return;
              const file = event.dataTransfer.files?.[0] ?? null;
              if (file && isAudioFile(file)) {
                setSelectedFile(file);
                setError("");
              } else {
                setError("El archivo debe ser de audio.");
              }
            }}
          >
            <input
              id="audio-file-input"
              className="file-hidden"
              type="file"
              accept="audio/*"
              disabled={processing}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (!file) {
                  setSelectedFile(null);
                  return;
                }
                if (!isAudioFile(file)) {
                  setSelectedFile(null);
                  setError("El archivo debe ser de audio (webm, wav, mp3, ogg, m4a, aac, flac).");
                  return;
                }
                setSelectedFile(file);
                setError("");
              }}
            />
            <label htmlFor="audio-file-input" className="ghost">
              Seleccionar archivo
            </label>
            <p className="status">{selectedFileLabel}</p>
            <p className="status">Tambien puedes arrastrar y soltar aqui.</p>
          </div>
          <button
            type="button"
            className="ghost"
            onClick={() => void uploadSelectedFile()}
            disabled={processing || !selectedFile}
          >
            Subir y traducir/transcribir
          </button>
        </section>

        <section className="panel history">
          <div className="history-header">
            <p className="panel-title">Historial</p>
            <button
              type="button"
              className="ghost"
              onClick={() => void loadRecordings(currentUser)}
              disabled={loading}
            >
              Actualizar
            </button>
          </div>

          {loading ? <p className="empty">Cargando historial...</p> : null}
          {!loading && items.length === 0 ? (
            <p className="empty">
              Todavia no hay grabaciones para este usuario.
            </p>
          ) : null}

          <div className="cards">
            {items.map((item) => (
              <article className="card" key={item.id}>
                <div className="card-head">
                  <time>
                    {new Date(item.createdAt).toLocaleString("es-AR", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                  <span className="chip">{languageLabel(item.detectedLanguage)}</span>
                </div>

                <p className="meta">
                  Duracion: {Math.max(0, Math.round(item.durationSeconds))}s
                </p>
                <p className="meta">
                  Hablantes detectados: {item.speakerCount ?? 1}
                  {item.speakerRoles && item.speakerRoles.length > 0
                    ? ` (${item.speakerRoles.join(", ")})`
                    : ""}
                </p>

                <div className="audio-stack">
                  <label>Audio original</label>
                  <audio controls src={item.inputAudioUrl} preload="none" />
                  <label>Resumen en audio</label>
                  <audio
                    controls
                    src={item.summaryAudioUrl ?? item.summaryAudioDataUrl}
                    preload="none"
                  />
                </div>

                <div className="text-block">
                  <h3>Transcripcion</h3>
                  <p>{item.transcript || "Sin contenido transcripto."}</p>
                </div>

                <div className="text-block">
                  <h3>Resumen</h3>
                  <p>{item.summary}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
