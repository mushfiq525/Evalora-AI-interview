# Evalora AI Interview Demo

Upload a CV. An AI interviewer ("Aria") on a video-call style screen interviews you on the skills in the CV, using the Gemini Live API (voice + camera).

## Run

1. Install Node.js 20 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and put your Gemini API key in it (https://aistudio.google.com/apikey).
4. `npm start`
5. Open http://localhost:3000 in Chrome or Edge. Use headphones.
6. Upload a CV (try `sample-cv.txt`), click **Join interview**, allow camera and microphone, and talk.
7. Click **Leave** to get the report.

## How it works

```
Browser                         Node server (server.js)            Gemini
mic (16 kHz PCM) + 1 fps JPEG -> WebSocket /ws  ->  ai.live.connect -> Live model
avatar + speaker (24 kHz PCM) <- WebSocket      <-  audio + transcripts
```

- `lib/cv.js` extracts CV text (pdf-parse, mammoth).
- `lib/analysis.js` finds skills and writes the final report (text model).
- `lib/prompt.js` is the interviewer prompt (the CV text is put inside it).
- `public/app.js` handles mic, camera, playback, the avatar mouth and the report screen.

## Settings (.env)

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_MODEL` | `gemini-3.8-live` | Live voice model |
| `TEXT_MODEL` | `gemini-3.8-flash` | CV skills and report |
| `USE_VERTEX` | `false` | `true` only for Google Cloud / Vertex AI express keys (start with `AQ.`) |
| `VOICE` | `Kore` | Gemini voice name |
| `INTERVIEW_MINUTES` | `10` | Planned length; the agent is told to wrap up one minute before |

## Troubleshooting

- **Model not found / connection closed**: check the current Live model name at https://ai.google.dev/gemini-api/docs/models and set `LIVE_MODEL`.
- **No sound**: click inside the page first, check the browser tab is not muted.
- **The AI hears itself**: use headphones.
- **Scanned PDF is rejected**: this demo reads text PDFs only (no OCR).
- **Skills list empty**: skill detection failed (see server terminal); the interview still works.
