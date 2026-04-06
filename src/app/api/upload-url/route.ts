import { NextResponse } from "next/server";

import { createSignedUploadTarget } from "@/lib/google-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadRequestBody = {
  mimeType?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as UploadRequestBody;
    const mimeType = body.mimeType?.trim() || "audio/webm";

    const target = await createSignedUploadTarget(mimeType);
    return NextResponse.json({
      ...target,
      mimeType,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo generar URL de carga.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
