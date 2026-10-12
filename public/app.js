const $ = (s) => document.querySelector(s);

const state = {
  sessionId: null,
  ws: null,
  stream: null,
  micCtx: null,
  playCtx: null,
  analyser: null,
  nextTime: 0,
  sources: new Set(),
  micOn: true,
  camOn: true,
  frameTimer: null,
  clockTimer: null,
  startedAt: 0,
  level: 0,
  leaving: false,
};

const show = (id) => {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
};

const b64FromBytes = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const setStatus = (msg, err = false) => {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', err);
};

/* ---------- Step 1: CV upload ---------- */
$('#cvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#joinBtn').disabled = true;
  $('#analysis').classList.add('hidden');
  setStatus('Reading CV and finding skills…');

  const fd = new FormData();
  fd.append('cv', file);
  try {
    const res = await fetch('/api/cv', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Upload failed');

    state.sessionId = j.sessionId;
    $('#candName').textContent = j.analysis.candidateName || file.name;
    $('#skills').replaceChildren(...j.analysis.skills.map(chip));
    $('#topics').replaceChildren(...j.analysis.focusTopics.map(chip));
    $('#preview').textContent = j.preview;
    $('#analysis').classList.remove('hidden');
    setStatus(`Read ${j.chars.toLocaleString()} characters.` + (j.analysis.skills.length ? '' : ' Skill detection skipped; the interviewer will decide topics from the CV.'));
    $('#joinBtn').disabled = false;
  } catch (err) {
    setStatus(err.message, true);
  }
});

function chip(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

/* ---------- Step 2: join the meeting ---------- */
$('#joinBtn').addEventListener('click', async () => {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    });
  } catch {
    setStatus('Camera and microphone access is required. Allow them in the browser and try again.', true);
    return;
  }

  state.leaving = false;
  show('meeting');
  $('#selfVideo').srcObject = state.stream;
  overlay('Connecting to the interviewer…');

  // Playback context (Gemini sends 24 kHz audio). Created inside the click so the browser allows sound.
  state.playCtx = new AudioContext({ sampleRate: 24000 });
  await state.playCtx.resume();
  state.analyser = state.playCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.analyser.connect(state.playCtx.destination);
  state.nextTime = 0;
  avatarLoop();

  connect();
});

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?session=${state.sessionId}`);
  state.ws = ws;

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'ready':
        overlay(null);
        startStreaming();
        startClock();
        break;
      case 'audio':
        playPcm(m.data);
        break;
      case 'caption':
        $('#captions').innerHTML = '';
        $('#captions').append(Object.assign(document.createElement('b'), { textContent: m.role === 'ai' ? 'Aria: ' : 'You: ' }), document.createTextNode(m.text));
        break;
      case 'interrupted':
        stopPlayback();
        break;
      case 'timeUp':
        leave();
        break;
      case 'report':
        stopMedia();
        renderReport(m.report, m.transcript, m.flags);
        show('report');
        break;
      case 'error':
        if (!state.leaving) {
          overlay(m.message + ' (see the server terminal for details)');
          setTimeout(() => $('#overlay').addEventListener('click', backToSetup, { once: true }), 0);
        }
        break;
    }
  };
  ws.onclose = () => {
    if (!state.leaving && !$('#meeting').classList.contains('hidden')) overlay('Connection closed. Click to go back.');
  };
}

/* ---------- Streaming mic + camera to the server ---------- */
async function startStreaming() {
  // Microphone -> 16 kHz PCM
  state.micCtx = new AudioContext();
  await state.micCtx.audioWorklet.addModule('/pcm-worklet.js');
  const src = state.micCtx.createMediaStreamSource(new MediaStream(state.stream.getAudioTracks()));
  const node = new AudioWorkletNode(state.micCtx, 'pcm-processor');
  node.port.onmessage = (e) => {
    if (!state.micOn || state.ws?.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type: 'audio', data: b64FromBytes(new Uint8Array(e.data)) }));
  };
  const mute = state.micCtx.createGain(); // keeps the worklet running without playing the mic back
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(state.micCtx.destination);

  // Camera -> 1 JPEG frame per second (the Live API maximum)
  const video = $('#selfVideo');
  const canvas = document.createElement('canvas');
  state.frameTimer = setInterval(() => {
    if (!state.camOn || state.ws?.readyState !== 1 || !video.videoWidth) return;
    const w = 512;
    canvas.width = w;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const r = new FileReader();
        r.onload = () => state.ws?.readyState === 1 && state.ws.send(JSON.stringify({ type: 'video', data: String(r.result).split(',')[1] }));
        r.readAsDataURL(blob);
      },
      'image/jpeg',
      0.6,
    );
  }, 1000);

  startAttention(); // face / camera check (loads in the background)
}

/* ---------- Playing the AI voice ---------- */
function playPcm(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    f32[i] = v / 32768;
  }
  const ctx = state.playCtx;
  const buf = ctx.createBuffer(1, n, 24000);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.analyser);
  const t = Math.max(ctx.currentTime + 0.02, state.nextTime);
  src.start(t);
  state.nextTime = t + buf.duration;
  state.sources.add(src);
  src.onended = () => state.sources.delete(src);
}

function stopPlayback() {
  for (const s of state.sources) {
    try {
      s.stop();
    } catch {}
  }
  state.sources.clear();
  state.nextTime = 0;
}

/* ---------- Avatar: mouth follows the loudness of the AI voice ---------- */
function avatarLoop() {
  const mouth = $('#mouth');
  const tile = $('#aiTile');
  const buf = new Uint8Array(state.analyser.fftSize);
  const tick = () => {
    if (!state.analyser) return;
    state.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const target = Math.min(1, Math.sqrt(sum / buf.length) * 6);
    state.level += (target - state.level) * 0.4;
    mouth.setAttribute('ry', (1.5 + state.level * 11).toFixed(2));
    mouth.setAttribute('rx', (10 - state.level * 2).toFixed(2));
    tile.classList.toggle('speaking', state.level > 0.08);
    requestAnimationFrame(tick);
  };
  tick();
}

/* ---------- Controls ---------- */
$('#micBtn').addEventListener('click', () => {
  state.micOn = !state.micOn;
  state.stream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  $('#micBtn').classList.toggle('off', !state.micOn);
  $('#micBtn').textContent = state.micOn ? '🎤' : '🔇';
});
$('#camBtn').addEventListener('click', () => {
  state.camOn = !state.camOn;
  state.stream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  $('#selfVideo').classList.toggle('off', !state.camOn);
  $('#camBtn').classList.toggle('off', !state.camOn);
});
$('#leaveBtn').addEventListener('click', leave);
$('#againBtn').addEventListener('click', () => location.reload());

function leave() {
  if (state.leaving) return;
  state.leaving = true;
  overlay('Interview finished. Generating the report…');
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'end' }));
  else backToSetup();
}

function backToSetup() {
  stopMedia();
  state.ws?.close();
  show('setup');
}

function stopMedia() {
  clearInterval(state.frameTimer);
  clearInterval(state.clockTimer);
  stopPlayback();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.micCtx?.close();
  state.playCtx?.close();
  state.analyser = null;
  clearInterval(attention.timer);
  try {
    attention.landmarker?.close();
  } catch {}
  attention.landmarker = null;
}

function overlay(text) {
  $('#overlay').classList.toggle('hidden', !text);
  if (text) $('#overlayText').textContent = text;
}

function startClock() {
  state.startedAt = Date.now();
  state.clockTimer = setInterval(() => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

/* ---------- Report ---------- */
function renderReport(r, transcript, flags) {
  const body = $('#reportBody');
  body.replaceChildren();
  const el = (tag, text, cls) => Object.assign(document.createElement(tag), { textContent: text ?? '', className: cls || '' });

  if (r.error) {
    body.append(el('p', r.error));
  } else {
    body.append(el('div', `${r.overallScore ?? '–'} / 100`, 'score'), el('p', r.summary));
    if (r.topics?.length) {
      body.append(el('h3', 'Topics'));
      for (const t of r.topics) {
        const d = el('div', '', 'topic');
        d.append(el('b', `${t.score}/10`), document.createTextNode(` ${t.topic}: ${t.evidence}`));
        body.append(d);
      }
    }
    for (const [title, key] of [['Strengths', 'strengths'], ['Gaps', 'gaps'], ['Red flags', 'redFlags'], ['Suggested follow-ups', 'suggestedFollowUps']]) {
      if (!r[key]?.length) continue;
      body.append(el('h3', title));
      const ul = document.createElement('ul');
      r[key].forEach((x) => ul.append(el('li', x)));
      body.append(ul);
    }
  }

  if (flags?.length) {
    const label = { away: 'Looked away from the screen', noface: 'No face visible', multiple: 'More than one face visible', dark: 'Camera dark or covered', camoff: 'Camera off / no video' };
    const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    body.append(el('h3', 'Integrity flags (for human review, not part of the score)'));
    const ul = document.createElement('ul');
    flags.forEach((f) => ul.append(el('li', `${mmss(f.at)}  ${label[f.issue] || f.issue}`)));
    body.append(ul);
  }

  $('#transcript').replaceChildren(
    ...(transcript || []).map((t) => {
      const p = el('p', `${t.role === 'ai' ? 'Aria' : 'Candidate'}: ${t.text}`);
      if (t.role === 'ai') p.className = 'ai';
      return p;
    }),
  );
}

/* ---------- Camera / attention check (runs in the browser) ----------
   Checks every 0.5 s: is the picture black, is a face visible, how many faces, is the head turned away.
   When a problem lasts long enough it tells the server, which tells Aria to say something polite.
   Nothing here changes the interview score. */
const ATTENTION = {
  AWAY_RATIO_LOW: 0.34, // nose position between the face edges: 0.5 = facing the screen
  AWAY_RATIO_HIGH: 0.66,
  DARK_BRIGHTNESS: 12, // 0-255 average; below this the picture counts as black
  SECONDS: { away: 2, noface: 2, multiple: 2, dark: 2 }, // how long before we react
  COOLDOWN_MS: 30000, // same issue is reported at most this often
};
const attention = { landmarker: null, timer: null, since: {}, lastSent: {}, canvas: null };

async function startAttention() {
  attention.canvas = document.createElement('canvas');
  attention.canvas.width = 32;
  attention.canvas.height = 24;
  try {
    const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
    const V = await import(base + '/vision_bundle.mjs');
    const files = await V.FilesetResolver.forVisionTasks(base + '/wasm');
    attention.landmarker = await V.FaceLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numFaces: 2,
    });
    console.log('Face check ready');
  } catch (e) {
    console.warn('Face check unavailable (only the dark-picture check will run):', e);
  }
  attention.timer = setInterval(checkAttention, 500);
}

function checkAttention() {
  const video = $('#selfVideo');
  if (!state.camOn || !video.videoWidth || state.ws?.readyState !== 1) {
    attention.since = {};
    return;
  }

  let issue = null;

  // 1. Black picture (lens covered, privacy shutter)
  const ctx = attention.canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 24);
  const px = ctx.getImageData(0, 0, 32, 24).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  if (sum / (px.length / 4) < ATTENTION.DARK_BRIGHTNESS) issue = 'dark';

  // 2. Faces and head direction
  if (!issue && attention.landmarker) {
    let faces = [];
    try {
      faces = attention.landmarker.detectForVideo(video, performance.now()).faceLandmarks || [];
    } catch {}
    if (faces.length === 0) issue = 'noface';
    else if (faces.length > 1) issue = 'multiple';
    else {
      const l = faces[0];
      const ratio = (l[1].x - l[234].x) / (l[454].x - l[234].x); // nose tip vs left/right face edge
      if (ratio < ATTENTION.AWAY_RATIO_LOW || ratio > ATTENTION.AWAY_RATIO_HIGH) issue = 'away';
    }
  }

  // Forget issues that went away
  for (const k of Object.keys(attention.since)) if (k !== issue) delete attention.since[k];
  if (!issue) return;

  const now = Date.now();
  attention.since[issue] ??= now;
  const seconds = (now - attention.since[issue]) / 1000;
  if (seconds >= ATTENTION.SECONDS[issue] && now - (attention.lastSent[issue] || 0) > ATTENTION.COOLDOWN_MS) {
    attention.lastSent[issue] = now;
    state.ws.send(JSON.stringify({ type: 'attention', issue, seconds: Math.round(seconds) }));
  }
}