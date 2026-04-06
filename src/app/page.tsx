"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { RecordingItem } from "@/lib/types";

const LOCAL_STORAGE_KEY = "recorder-web-history";
const MAX_RECORDING_SECONDS = 1200;

function languageLabel(code: RecordingItem["detectedLanguage"]) {
  if (code === "en-US") return "Ingles";
  if (code === "he-IL") return "Hebreo";
  if (code === "es-AR") return "Espanol";
  return "Sin detectar";
}

export default function Home() {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);

  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const autoStoppingRef = useRef(false);

  useEffect(() => {
    void loadRecordings();
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });

    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
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

    if (timerRef.current) {
      window.clearInterval(timerRef.current);
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());

    setRecording(false);
    setProcessing(true);
    autoStoppingRef.current = false;

    try {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
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
        throw new Error(
          prepData.error ?? "No se pudo preparar la subida del audio.",
        );
      }

      const uploadResponse = await fetch(prepData.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": prepData.mimeType,
        },
        body: blob,
      });

      if (!uploadResponse.ok) {
        throw new Error("Fallo la subida del audio a Google Cloud Storage.");
      }

      const response = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gcsUri: prepData.gcsUri,
          inputAudioUrl: prepData.downloadUrl,
          durationSeconds: seconds,
          mimeType: prepData.mimeType,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        recording?: RecordingItem;
      };

      if (!response.ok || !data.recording) {
        throw new Error(data.error ?? "No se pudo procesar la grabacion.");
      }

      setItems((previous) => {
        const next = [data.recording as RecordingItem, ...previous];
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      setSeconds(0);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No se pudo completar el proceso.",
      );
    } finally {
      setProcessing(false);
      chunksRef.current = [];
    }
  }

  const statusText = useMemo(() => {
    if (processing) return "Procesando audio, transcripcion, resumen y voz...";
    if (recording) return `Grabando ${seconds}s`;
    return "Listo para grabar";
  }, [processing, recording, seconds]);

  return (
    <div className="app-shell">
      <main className="studio">
        <header className="hero">
          <p className="eyebrow">Audio Journal</p>
          <h1>Grabador multilenguaje con transcripcion y resumen hablado</h1>
          <p className="subtitle">
            Reconoce espanol, ingles y hebreo. Guarda cada grabacion con su
            audio original, transcripcion, resumen y narracion automatica.
          </p>
        </header>

        <section className="panel controls">
          <div>
            <p className="panel-title">Nueva grabacion</p>
            <p className="status">{statusText}</p>
            <p className="status">
              Optimo: entre 2 y 10 minutos. Maximo automatico: 20 minutos.
            </p>
          </div>
          <button
            type="button"
            className={`record-button ${recording ? "danger" : ""}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={processing}
          >
            {recording ? "Detener y procesar" : "Comenzar a grabar"}
          </button>
          {error ? <p className="error">{error}</p> : null}
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

                <p className="meta">Duracion: {Math.max(0, Math.round(item.durationSeconds))}s</p>

                <div className="audio-stack">
                  <label>Audio original</label>
                  <audio
                    controls
                    src={item.inputAudioUrl}
                    preload="none"
                  />
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
