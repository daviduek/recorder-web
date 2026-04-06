"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RecordingItem } from "@/lib/types";

const LOCAL_STORAGE_KEY = "recorder-web-history";
const MAX_RECORDING_SECONDS = 1200;

type TranscriptionJob = {
  operations: Array<{ source: "auto" | "es" | "en" | "he"; operationName: string }>;
  mimeType: string;
};

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

  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const autoStoppingRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);
  const processingStartedAtRef = useRef<number>(0);
  const estimatedTotalSecondsRef = useRef<number>(0);

  useEffect(() => {
    void loadRecordings();
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (progressTimerRef.current) window.clearInterval(progressTimerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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

  async function loadRecordings() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/recordings", { cache: "no-store" });
      const data = (await response.json()) as { recordings: RecordingItem[] };
      const apiRecordings = data.recordings ?? [];

      if (apiRecordings.length > 0) {
        setItems(apiRecordings);
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(apiRecordings));
      } else {
        const local = localStorage.getItem(LOCAL_STORAGE_KEY);
        setItems(local ? (JSON.parse(local) as RecordingItem[]) : []);
      }
    } catch {
      const local = localStorage.getItem(LOCAL_STORAGE_KEY);
      setItems(local ? (JSON.parse(local) as RecordingItem[]) : []);
    } finally {
      setLoading(false);
    }
  }

  async function startRecording() {
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
    if (!recorderRef.current) return;

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

  async function processAudioBlob(blob: Blob, durationSeconds: number, filename: string) {
    setProcessing(true);
    setError("");
    startProgressTracking(durationSeconds);

    try {
      setStep("Solicitando URL segura de carga...", 12);
      const prepResponse = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: blob.type || "audio/webm" }),
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
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
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
      setError("Selecciona un archivo de audio primero.");
      return;
    }

    const assumedSeconds = Math.max(60, Math.round(selectedFile.size / (24_000)));
    await processAudioBlob(selectedFile, assumedSeconds, selectedFile.name);
  }

  const statusText = useMemo(() => {
    if (processing) return "Procesando audio, transcripcion, contexto y resumen...";
    if (recording) return `Grabando ${seconds}s`;
    return "Listo para grabar o subir archivo";
  }, [processing, recording, seconds]);

  return (
    <div className="app-shell">
      <main className="studio">
        <header className="hero">
          <p className="eyebrow">Audio Journal</p>
          <h1>Grabador multilenguaje con transcripcion y resumen hablado</h1>
          <p className="subtitle">
            Soporta grabacion directa y subida de archivos de audio largos (hasta
            1 hora). Detecta hasta 3 hablantes y mezcla espanol, ingles y hebreo.
          </p>
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
          <input
            type="file"
            accept="audio/*"
            disabled={processing}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setSelectedFile(file);
            }}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => void uploadSelectedFile()}
            disabled={processing || !selectedFile}
          >
            Subir y procesar archivo
          </button>
        </section>

        <section className="panel history">
          <div className="history-header">
            <p className="panel-title">Historial</p>
            <button
              type="button"
              className="ghost"
              onClick={() => void loadRecordings()}
              disabled={loading}
            >
              Actualizar
            </button>
          </div>

          {loading ? <p className="empty">Cargando historial...</p> : null}
          {!loading && items.length === 0 ? (
            <p className="empty">
              Todavia no hay grabaciones. Hace la primera para iniciar el
              registro.
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
