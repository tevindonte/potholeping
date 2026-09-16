/**
 * Camera feed + live detection loop + confirm/cooldown logging.
 */

import './style.css';
import { loadModel, detect } from './inference.js';
import { computeSeverity, severityColor } from './severity.js';
import { ensureSession, createSessionId, logDetection } from './appwrite.js';

const INFER_INTERVAL_MS = 250;
const CONFIRM_N = 3;
const COOLDOWN_MS = 9000;
const JPEG_QUALITY = 0.72;

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const logCountEl = document.getElementById('logCount');

let stream = null;
let running = false;
let inferTimer = null;
let driveSessionId = null;
let streak = 0;
let lastLoggedAt = 0;
let loggedCount = 0;
let logging = false;
let inferBusy = false;
let lastDetections = [];
let lastCoords = null;

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function syncCanvasSize() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
}

function drawDetections(detections, provisionalSeverity) {
  syncCanvasSize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  for (const det of detections) {
    const severity = provisionalSeverity ?? computeSeverity(
      det,
      overlay.width,
      overlay.height,
      streak
    );
    const color = severityColor(severity);
    const w = det.x2 - det.x1;
    const h = det.y2 - det.y1;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, overlay.width / 240);
    ctx.strokeRect(det.x1, det.y1, w, h);

    const label = `${(det.confidence * 100).toFixed(0)}% · S${severity}`;
    ctx.font = `bold ${Math.max(12, overlay.width / 40)}px "DM Sans", sans-serif`;
    const pad = 4;
    const tw = ctx.measureText(label).width;
    const th = Math.max(14, overlay.width / 36);
    ctx.fillStyle = color;
    ctx.fillRect(det.x1, Math.max(0, det.y1 - th - pad), tw + pad * 2, th + pad);
    ctx.fillStyle = '#0b1220';
    ctx.fillText(label, det.x1 + pad, Math.max(th - 2, det.y1 - pad - 2));
  }
}

function requestGeo() {
  if (!navigator.geolocation) {
    setStatus('Geolocation not supported on this device', 'warn');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastCoords = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      setStatus('Location ready — tap Start Detecting');
    },
    (err) => {
      setStatus(`Location permission needed: ${err.message}`, 'warn');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );

  // Keep coords fresh while driving
  navigator.geolocation.watchPosition(
    (pos) => {
      lastCoords = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  await video.play();
  syncCanvasSize();
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

function captureFrameBlob() {
  return new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const cctx = c.getContext('2d');
    cctx.drawImage(video, 0, 0);
    c.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Frame capture failed'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

async function confirmAndLog(bestDet) {
  if (logging) return;
  const now = Date.now();
  if (now - lastLoggedAt < COOLDOWN_MS) return;
  if (!lastCoords) {
    setStatus('Waiting for GPS fix…', 'warn');
    return;
  }

  logging = true;
  setStatus('Logging pothole…', 'ok');

  try {
    const severity = computeSeverity(
      bestDet,
      video.videoWidth,
      video.videoHeight,
      streak
    );
    const blob = await captureFrameBlob();

    await logDetection({
      blob,
      latitude: lastCoords.latitude,
      longitude: lastCoords.longitude,
      severity,
      confidence: bestDet.confidence,
      sessionId: driveSessionId,
    });

    lastLoggedAt = Date.now();
    streak = 0;
    loggedCount += 1;
    logCountEl.textContent = String(loggedCount);
    setStatus(`Logged · severity ${severity} · cooldown ${COOLDOWN_MS / 1000}s`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Log failed: ${err.message || err}`, 'err');
  } finally {
    logging = false;
  }
}

async function inferenceTick() {
  if (!running || video.readyState < 2 || inferBusy) return;
  inferBusy = true;

  try {
    const detections = await detect(video);
    lastDetections = detections;
    drawDetections(detections);

    const inCooldown = Date.now() - lastLoggedAt < COOLDOWN_MS;

    if (detections.length > 0 && !inCooldown) {
      streak += 1;
      setStatus(`Detecting… streak ${streak}/${CONFIRM_N}`);
      if (streak >= CONFIRM_N) {
        const best = detections.reduce((a, b) =>
          a.confidence >= b.confidence ? a : b
        );
        await confirmAndLog(best);
      }
    } else if (detections.length === 0) {
      streak = 0;
      if (!inCooldown && running) setStatus('Scanning for potholes…');
    } else if (inCooldown) {
      streak = 0;
      const left = Math.ceil((COOLDOWN_MS - (Date.now() - lastLoggedAt)) / 1000);
      setStatus(`Cooldown ${left}s`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Inference error: ${err.message || err}`, 'err');
  } finally {
    inferBusy = false;
  }
}

async function startDetecting() {
  startBtn.disabled = true;
  setStatus('Starting camera…');

  try {
    await startCamera();
    driveSessionId = createSessionId();
    streak = 0;
    lastLoggedAt = 0;
    running = true;
    stopBtn.disabled = false;
    setStatus('Scanning for potholes…');
    inferTimer = setInterval(inferenceTick, INFER_INTERVAL_MS);
  } catch (err) {
    console.error(err);
    setStatus(`Camera error: ${err.message || err}`, 'err');
    startBtn.disabled = false;
  }
}

function stopDetecting() {
  running = false;
  if (inferTimer) {
    clearInterval(inferTimer);
    inferTimer = null;
  }
  stopCamera();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped');
}

async function boot() {
  startBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus('Loading model…');

  try {
    await loadModel();
  } catch (err) {
    console.error(err);
    setStatus(`Model init failed: ${err.message || err}`, 'err');
    return;
  }

  try {
    await ensureSession();
    setStatus('Model ready — allow location, then Start Detecting');
    startBtn.disabled = false;
    requestGeo();
  } catch (err) {
    console.error(err);
    setStatus(`Appwrite init failed: ${err.message || err}`, 'err');
  }
}

startBtn.addEventListener('click', startDetecting);
stopBtn.addEventListener('click', stopDetecting);
window.addEventListener('beforeunload', stopDetecting);

boot();
