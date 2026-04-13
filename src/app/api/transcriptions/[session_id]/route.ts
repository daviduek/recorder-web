/**
 * GET /api/transcriptions/:session_id
 *
 * Returns all recordings associated with a given session ID,
 * sorted by most recent first.
 *
 * ─── Notes ────────────────────────────────────────────────────────────────────
 *
 *  - Only functional in non-Vercel environments where the local JSON store
 *    exists. On Vercel, recordings live exclusively in client-side localStorage,
 *    so an empty array is returned (consistent with GET /api/recordings behavior).
 *
 *  - session_id is set when the client calls POST /api/recordings with a
 *    `session_id` field. Sessions are client-generated UUIDs.
 *
 * ─── Response ─────────────────────────────────────────────────────────────────
 *  200  { recordings: RecordingItem[] }
 *  400  { error: string }   — invalid or missing session_id
 *  500  { error: string }   — storage read failure
 */

import { NextResponse } from "next/server";

import { getRecordingsBySession } from "@/lib/recordings-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  // On Vercel, client localStorage is the source of truth for history
  if (process.env.VERCEL) {
    return NextResponse.json({ recordings: [] });
  }

  const { session_id } = await params;

  if (!session_id || session_id.trim().length === 0) {
    return NextResponse.json(
      { error: "session_id inválido." },
      { status: 400 },
    );
  }

  try {
    const recordings = await getRecordingsBySession(session_id.trim());
    return NextResponse.json({ recordings });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudieron obtener las grabaciones.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
