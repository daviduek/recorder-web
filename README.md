# Recorder Web (Google)

App web para:
- grabar audio desde el navegador,
- transcribirlo (espanol, ingles, hebreo),
- generar resumen,
- sintetizar el resumen en audio,
- guardar un historial completo de cada grabacion.

## Stack

- Next.js 16 + App Router
- Google Cloud Speech-to-Text
- Gemini (Google AI Studio API) para resumen
- Google Cloud Text-to-Speech
- Persistencia local en archivos (`/data/recordings.json`) y audios en `public`

## 1) Variables de entorno

Copiar `.env.example` a `.env.local` y completar:

```bash
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
GOOGLE_CREDENTIALS_JSON=base64_or_json_service_account
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-2.5-flash
```

Para deploy (por ejemplo en Vercel), usa `GOOGLE_CREDENTIALS_JSON` con el JSON completo de la service account (o en base64). En local podes seguir usando `GOOGLE_APPLICATION_CREDENTIALS`.

## 2) Servicios a habilitar en Google Cloud

- Speech-to-Text API
- Text-to-Speech API

Con la service account, asignar permisos para ambos servicios.

## 3) Ejecutar

```bash
npm install
npm run dev
```

Abrir:
- http://localhost:3000

## Deploy recomendado (Vercel)

1. Importar el repo en Vercel.
2. Definir variables de entorno:
   - `GOOGLE_CREDENTIALS_JSON`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (opcional)
3. Deploy.

## Flujo funcional

1. El usuario graba desde la web.
2. Se sube el audio a `/api/recordings`.
3. Se guarda audio original en `public/uploads`.
4. Se transcribe con STT (idiomas configurados: `es-AR`, `en-US`, `iw-IL`).
5. Se resume con Gemini.
6. Se genera audio del resumen con TTS y se guarda en `public/summaries`.
7. Se guarda registro en `data/recordings.json`.

## Notas

- Si falta `GEMINI_API_KEY`, la app usa un resumen fallback basico para no cortar el flujo.
- El historial queda local en disco del proyecto (ideal para MVP).
