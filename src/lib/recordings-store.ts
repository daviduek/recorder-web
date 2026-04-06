import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RecordingItem } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const RECORDINGS_FILE = path.join(DATA_DIR, "recordings.json");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const INPUT_AUDIO_DIR = path.join(PUBLIC_DIR, "uploads");
const SUMMARY_AUDIO_DIR = path.join(PUBLIC_DIR, "summaries");

async function ensureDirs() {
  await Promise.all([
    mkdir(DATA_DIR, { recursive: true }),
    mkdir(INPUT_AUDIO_DIR, { recursive: true }),
    mkdir(SUMMARY_AUDIO_DIR, { recursive: true }),
  ]);
}

export async function readRecordings(): Promise<RecordingItem[]> {
  await ensureDirs();

  try {
    const raw = await readFile(RECORDINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as RecordingItem[];

    return parsed.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } catch {
    return [];
  }
}

export async function saveInputAudio(
  id: string,
  extension: string,
  buffer: Buffer,
) {
  await ensureDirs();
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const fileName = `${id}.${safeExtension || "webm"}`;
  const filePath = path.join(INPUT_AUDIO_DIR, fileName);
  await writeFile(filePath, buffer);
  return `/uploads/${fileName}`;
}

export async function saveSummaryAudio(id: string, buffer: Buffer) {
  await ensureDirs();
  const fileName = `${id}.mp3`;
  const filePath = path.join(SUMMARY_AUDIO_DIR, fileName);
  await writeFile(filePath, buffer);
  return `/summaries/${fileName}`;
}

export async function appendRecording(recording: RecordingItem) {
  const previous = await readRecordings();
  const updated = [recording, ...previous];
  await writeFile(RECORDINGS_FILE, JSON.stringify(updated, null, 2), "utf-8");
}
