import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

import { extractCvText } from './lib/cv.js';
import { analyzeCv, buildReport } from './lib/analysis.js';
import { buildSystemPrompt } from './lib/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.8-flash';
const VOICE = process.env.VOICE || 'Kore';
const MINUTES = Number(process.env.INTERVIEW_MINUTES || 10);
// 'realtime' = send notes with sendRealtimeInput. If Aria does not react to notes, set NUDGE_MODE=content in .env.
const NUDGE_MODE = process.env.NUDGE_MODE || 'realtime';

// What Aria is told when the browser or server notices a camera / attention problem
const NOTES = {
  camoff: "[System note] The candidate's camera appears to be off or not sending video. Politely ask them to turn the camera on and show their face before you continue.",
  dark: "[System note] The candidate's video is black or covered. Politely ask them to uncover or turn on the camera.",
  noface: "[System note] No face is visible in the candidate's video. Politely ask them to move into the frame and show their face before you continue.",
  away: "[System note] The candidate has been looking away from the screen for several seconds. Politely remind them, once, to look toward the camera while answering. Do not accuse them of anything.",
  multiple: "[System note] More than one person may be visible in the candidate's video. Politely ask the candidate to be alone on camera for the interview. Do not accuse anyone.",
};

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}
// The key stays on the server. The browser never sees it.
// USE_VERTEX=true is for Google Cloud / Vertex AI "express mode" keys (they start with "AQ.").
// Keys from Google AI Studio (they start with "AIza") need USE_VERTEX=false.
const USE_VERTEX = process.env.USE_VERTEX === 'true';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, vertexai: USE_VERTEX });

// sessionId -> { cvText, analysis }   (in memory; demo only)
const sessions = new Map();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Step 1: upload CV -> extract text -> detect skills
app.post('/api/cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const cvText = await extractCvText(req.file);
    if (cvText.length < 200) {
      return res.status(422).json({
        error: 'Could not read enough text. Scanned (image-only) PDFs are not supported in this demo.',
      });
    }
    const analysis = await analyzeCv(ai, TEXT_MODEL, cvText);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cvText, analysis });
    res.json({ sessionId, chars: cvText.length, preview: cvText, analysis });
  } catch (e) {
    console.error('[/api/cv]', e);
    res.status(400).json({ error: e.message || 'Could not read the CV.' });
  }
});

// multer errors (file too large, etc.)
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : err.message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Step 2: one WebSocket per interview. Browser <-> this server <-> Gemini Live
wss.on('connection', async (ws, req) => {
  const sessionId = new URL(req.url, 'http://localhost').searchParams.get('session');
  const data = sessions.get(sessionId);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  if (!data) {
    send({ type: 'error', message: 'Unknown session. Upload the CV again.' });
    return ws.close();
  }

  const transcript = []; // [{ role: 'ai' | 'candidate', text }]
  let current = null; // the line being spoken right now
  let live = null;
  let finished = false;
  let wrapUpTimer = null;
  let hardStopTimer = null;
  let cameraTimer = null; // checks that camera frames keep arriving
  let lastFrameAt = Date.now(); // when the last camera frame arrived
  let lastNudgeAt = 0; // when we last sent Aria a note
  const startedAt = Date.now();
  const flags = []; // [{ at: seconds, issue }]  integrity signals for a human reviewer, never scored

  // Tell Aria something. At most one note every 15 s so she does not pile up reminders.
  const nudge = (text) => {
    const now = Date.now();
    if (!live || now - lastNudgeAt < 5000) return;
    lastNudgeAt = now;
    console.log('[nudge]', text.slice(0, 70) + '...');
    try {
      if (NUDGE_MODE === 'content') {
        live.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
      } else {
        live.sendRealtimeInput({ text });
      }
    } catch (e) {
      console.error('[nudge] failed', e.message);
    }
  };

  const addText = (role, chunk) => {
    if (!current || current.role !== role) {
      current = { role, text: '' };
      transcript.push(current);
    }
    current.text += chunk;
    send({ type: 'caption', role, text: current.text });
  };

  const onMessage = (m) => {
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) addText('candidate', sc.inputTranscription.text);
    
    if (sc.outputTranscription?.text) {
      addText('ai', sc.outputTranscription.text);
    }

    // Check if the current AI message contains closing intent
    if (current && current.role === 'ai') {
      const text = current.text.toLowerCase();
      if (
        (text.includes('thank you') && text.includes('time')) ||
        text.includes('have a great day') ||
        text.includes('interview is complete')
      ) {
        if (!finished) {
          setTimeout(async () => {
            if (!finished) {
              console.log('[live] Automatic wrap-up triggered by Aria closing statement.');
              await finish();
            }
          }, 3500); // 3.5s delay to let her finish talking
        }
      }
    }

    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) send({ type: 'audio', data: part.inlineData.data });
    }
    if (sc.interrupted) {
      send({ type: 'interrupted' });
      current = null;
    }
    if (sc.turnComplete) {
      send({ type: 'turnComplete' });
      current = null;
    }
  };

  const finish = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(wrapUpTimer);
    clearTimeout(hardStopTimer);
    clearInterval(cameraTimer);
    try {
      live?.close();
    } catch {}
    const report = await buildReport(ai, TEXT_MODEL, transcript, data.analysis);
    send({ type: 'report', report, transcript, flags });
    ws.close();
  };

  try {
    live = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildSystemPrompt({
          cvText: data.cvText,
          analysis: data.analysis,
          minutes: MINUTES,
        }),
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Audio+video sessions are cut after ~2 min without this
        contextWindowCompression: { slidingWindow: {} },
      },
      callbacks: {
        onopen: () => console.log('[live] connected', sessionId),
        onmessage: onMessage,
        onerror: (e) => {
          console.error('[live] error', e?.message || e);
          send({ type: 'error', message: e?.message || 'Gemini connection error' });
        },
        onclose: (e) => {
          console.log('[live] closed', e?.reason || '');
          if (!finished) send({ type: 'error', message: 'Gemini closed the session: ' + (e?.reason || 'unknown reason') });
        },
      },
    });

    send({ type: 'ready', minutes: MINUTES });
    // Make the agent speak first
    live.sendRealtimeInput({ text: 'The candidate has joined the call. Begin the interview now.' });

    wrapUpTimer = setTimeout(() => {
      live?.sendRealtimeInput({
        text: '[Interviewer note] About one minute is left. Finish the current question, thank the candidate and close the interview.',
      });
    }, Math.max(1, MINUTES - 1) * 60 * 1000);
    hardStopTimer = setTimeout(() => send({ type: 'timeUp' }), (MINUTES + 1) * 60 * 1000);

    // Camera watchdog: if no video frame arrives for 8 s, tell Aria to ask for the camera (at most every 30 s)
    lastFrameAt = Date.now();
    cameraTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastFrameAt > 8000 && now - lastNudgeAt > 30000) {
        console.log('[camera] no video frames for 8 s');
        flags.push({ at: Math.round((now - startedAt) / 1000), issue: 'camoff' });
        nudge(NOTES.camoff);
      }
    }, 3000);
  } catch (e) {
    console.error('[live] connect failed', e);
    send({ type: 'error', message: 'Could not start the Gemini Live session: ' + (e?.message || e) });
    return ws.close();
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (finished) return;
    try {
      if (msg.type === 'audio') {
        live.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } });
      } else if (msg.type === 'video') {
        lastFrameAt = Date.now();
        live.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } });
      } else if (msg.type === 'attention' && NOTES[msg.issue] && msg.issue !== 'camoff') {
        // Sent by the browser's face check. The issue name is validated against the NOTES list.
        console.log('[attention]', msg.issue);
        flags.push({ at: Math.round((Date.now() - startedAt) / 1000), issue: msg.issue });
        nudge(NOTES[msg.issue]);
      } else if (msg.type === 'end') {
        await finish();
      }
    } catch (e) {
      console.error('[ws] send to Gemini failed', e.message);
    }
  });

  ws.on('close', () => {
    if (!finished) {
      finished = true;
      clearTimeout(wrapUpTimer);
      clearTimeout(hardStopTimer);
      clearInterval(cameraTimer);
      try {
        live?.close();
      } catch {}
    }
  });
});

server.listen(PORT, async () => {
  console.log(`\nEvalora AI interview demo: http://localhost:${PORT}`);
  console.log(`Live model: ${LIVE_MODEL} | text model: ${TEXT_MODEL} | ${MINUTES} min | ${USE_VERTEX ? 'Vertex AI' : 'Gemini API'}\n`);

  // Quick key check so problems show up now, not in the middle of an interview
  try {
    await ai.models.generateContent({ model: TEXT_MODEL, contents: 'Reply with: ok' });
    console.log('API key check: OK\n');
  } catch (e) {
    console.error('API key check FAILED:', e?.message || e);
    console.error('Hints: key from aistudio.google.com/apikey -> USE_VERTEX=false. Key starting with "AQ." (Google Cloud) -> USE_VERTEX=true. Also check TEXT_MODEL.\n');
  }
});