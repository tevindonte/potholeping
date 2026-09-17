/**
 * Camera feed + live detection loop + offline queue + motion + alerts.
 */

import './style.css';
import { loadModel, detect } from './inference.js';
import { computeSeverity, severityColor } from './severity.js';
import {
  ensureSession,
  createSessionId,
  logDetection,
  listDetectionsBySession,
} from './appwrite.js';
import { unlockFeedback, pingLogged } from './feedback.js';
import {
  enqueueDetection,
  flushQueue,
  onQueueChange,
  pendingCount,
} from './queue.js';
import { exportCsv, exportGeoJson } from './export.js';
import {
  requestMotionPermission,
  startMotionTracking,
  stopMotionTracking,
  hadMotionSpikeNear,
} from './motion.js';
import { startProximityAlerts, stopProximityAlerts } from './alerts.js';

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
const pendingEl = document.getElementById('pendingCount');
const summaryEl = document.getElementById('sessionSummary');
const summaryBody = document.getElementById('summaryBody');
const summaryMapBtn = document.getElementById('summaryMapBtn');
const summaryCloseBtn = document.getElementById('summaryCloseBtn');
const summaryCsvBtn = document.getElementById('summaryCsvBtn');
const summaryGeoBtn = document.getElementById('summaryGeoBtn');

let stream = null;
let running = false;
let inferTimer = null;
let driveSessionId = null;
let sessionStartedAt = 0;
let streak = 0;
let lastLoggedAt = 0;
let loggedCount = 0;
let sessionLogs = [];
let logging = false;
let inferBusy = false;
let flushing = false;
/** @type {{ latitude: number, longitude: number, accuracy: number, timestamp: number } | null} */
let lastCoords = null;
let geoWatchId = null;
let motionOk = false;

/** Max age / accuracy for a fix to be considered fresh enough to log. */
const GPS_MAX_AGE_MS = 8000;
const GPS_MAX_ACCURACY_M = 75;

const GEO_OPTS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10000,
};

function applyPosition(pos) {
  lastCoords = {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? Infinity,
    timestamp: pos.timestamp || Date.now(),
  };
}

function gpsIsFresh(coords = lastCoords) {
  if (!coords) return false;
  const age = Date.now() - coords.timestamp;
  if (age > GPS_MAX_AGE_MS) return false;
  if (coords.accuracy > GPS_MAX_ACCURACY_M) return false;
  return true;
}

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function updatePendingUi(count) {
  if (!pendingEl) return;
  if (count > 0) {
    pendingEl.hidden = false;
    pendingEl.textContent = `${count} pending upload${count === 1 ? '' : 's'}`;
  } else {
    pendingEl.hidden = true;
    pendingEl.textContent = '';
  }
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

function drawDetections(detections) {
  syncCanvasSize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  for (const det of detections) {
    const severity = computeSeverity(
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

  // Continuous live track — never reuse a cached fix (maximumAge: 0).
  // Logging reads `lastCoords`; it does not call getCurrentPosition per detection.
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const first = !lastCoords;
      applyPosition(pos);
      if (first) setStatus('Location ready — tap Start Detecting');
    },
    (err) => {
      console.error('GPS watch error:', err);
      if (!lastCoords) {
        setStatus(`Location permission needed: ${err.message}`, 'warn');
      }
    },
    GEO_OPTS
  );

  // Optional one-shot to populate faster while the watch warms up
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      applyPosition(pos);
      setStatus('Location ready — tap Start Detecting');
    },
    () => {},
    GEO_OPTS
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

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function showSessionSummary() {
  const count = sessionLogs.length;
  const severities = sessionLogs.map((l) => l.severity);
  const worst = count ? Math.max(...severities) : 0;
  const avg = count
    ? (severities.reduce((a, b) => a + b, 0) / count).toFixed(1)
    : '—';
  const verified = sessionLogs.filter((l) => l.physicallyVerified).length;
  const duration = formatDuration(Date.now() - sessionStartedAt);

  if (count === 0) {
    summaryBody.innerHTML = `
      <p class="summary-lead">No potholes logged this drive.</p>
      <p class="summary-sub">Session lasted ${duration}. Keep the phone mounted and try again on a rougher stretch.</p>
    `;
  } else {
    summaryBody.innerHTML = `
      <p class="summary-lead"><strong>${count}</strong> pothole${count === 1 ? '' : 's'} logged</p>
      <p class="summary-sub">in ${duration}</p>
      <ul class="summary-stats">
        <li><span>Worst severity</span><strong>${worst}/5</strong></li>
        <li><span>Average</span><strong>${avg}/5</strong></li>
        <li><span>Physically verified</span><strong>${verified}/${count}</strong></li>
      </ul>
    `;
  }

  const hasExport = count > 0;
  if (summaryCsvBtn) summaryCsvBtn.disabled = !hasExport;
  if (summaryGeoBtn) summaryGeoBtn.disabled = !hasExport;

  summaryEl.hidden = false;
  summaryEl.setAttribute('aria-hidden', 'false');
}

function hideSessionSummary() {
  summaryEl.hidden = true;
  summaryEl.setAttribute('aria-hidden', 'true');
}

async function uploadDetection(entry) {
  return logDetection({
    blob: entry.blob,
    latitude: entry.latitude,
    longitude: entry.longitude,
    severity: entry.severity,
    confidence: entry.confidence,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    physicallyVerified: entry.physicallyVerified,
  });
}

async function tryFlushQueue() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const n = await flushQueue(uploadDetection);
    if (n > 0) setStatus(`Synced ${n} queued upload${n === 1 ? '' : 's'}`, 'ok');
  } finally {
    flushing = false;
  }
}

/** Never run IDB/network flush on the inference critical path. */
function scheduleFlush() {
  const run = () => {
    tryFlushQueue().catch((err) => console.warn('Deferred flush failed', err));
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 250);
  }
}

async function confirmAndLog(bestDet) {
  if (logging) return;
  const now = Date.now();
  if (now - lastLoggedAt < COOLDOWN_MS) return;
  if (!lastCoords) {
    setStatus('Waiting for GPS fix…', 'warn');
    return;
  }
  if (!gpsIsFresh(lastCoords)) {
    const ageSec = Math.round((Date.now() - lastCoords.timestamp) / 1000);
    setStatus(
      `Waiting for fresh GPS… (fix ~${Math.round(lastCoords.accuracy)}m, ${ageSec}s old)`,
      'warn'
    );
    return;
  }

  logging = true;
  setStatus('Logging pothole…', 'ok');

  try {
    // Snapshot the live watchPosition fix at confirm time (not a new getCurrentPosition)
    const coords = { ...lastCoords };
    const physicallyVerified = motionOk && hadMotionSpikeNear(now, 1000);
    const severity = computeSeverity(
      bestDet,
      video.videoWidth,
      video.videoHeight,
      streak,
      { physicallyVerified }
    );
    const blob = await captureFrameBlob();
    const createdAt = new Date().toISOString();
    const entry = {
      blob,
      latitude: coords.latitude,
      longitude: coords.longitude,
      severity,
      confidence: bestDet.confidence,
      sessionId: driveSessionId,
      createdAt,
      physicallyVerified,
    };

    // Always queue first so offline never loses a detection
    await enqueueDetection(entry);

    lastLoggedAt = Date.now();
    streak = 0;
    loggedCount += 1;
    sessionLogs.push({ ...entry, blob: undefined });
    logCountEl.textContent = String(loggedCount);
    pingLogged();

    const tag = physicallyVerified ? 'verified' : 'visual';
    setStatus(
      `Logged · S${severity} · ${tag} · cooldown ${COOLDOWN_MS / 1000}s`,
      'ok'
    );

    // Defer Appwrite/IDB flush so inference keeps getting frames
    scheduleFlush();
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
  hideSessionSummary();
  setStatus('Starting camera…');
  await unlockFeedback();

  motionOk = await requestMotionPermission();
  if (motionOk) startMotionTracking();

  try {
    await startCamera();
    driveSessionId = createSessionId();
    sessionStartedAt = Date.now();
    sessionLogs = [];
    streak = 0;
    lastLoggedAt = 0;
    loggedCount = 0;
    logCountEl.textContent = '0';
    running = true;
    stopBtn.disabled = false;
    startProximityAlerts(() => lastCoords);
    setStatus(
      motionOk
        ? 'Scanning for potholes… (motion on)'
        : 'Scanning for potholes… (visual only)'
    );
    inferTimer = setInterval(inferenceTick, INFER_INTERVAL_MS);
  } catch (err) {
    console.error(err);
    setStatus(`Camera error: ${err.message || err}`, 'err');
    startBtn.disabled = false;
    stopMotionTracking();
    stopProximityAlerts();
  }
}

function stopDetecting({ showSummary = true } = {}) {
  const wasRunning = running;
  running = false;
  if (inferTimer) {
    clearInterval(inferTimer);
    inferTimer = null;
  }
  stopCamera();
  stopMotionTracking();
  stopProximityAlerts();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus(wasRunning ? 'Stopped' : statusEl.textContent);

  if (showSummary && wasRunning && sessionStartedAt) {
    showSessionSummary();
  }
}

async function exportSession(kind) {
  let rows = sessionLogs.slice();
  try {
    if (driveSessionId && navigator.onLine) {
      const remote = await listDetectionsBySession(driveSessionId);
      if (remote.length) rows = remote;
    }
  } catch (err) {
    console.warn('Session fetch for export failed; using local logs', err);
  }
  if (!rows.length) return;
  if (kind === 'csv') exportCsv(rows, `potholeping-session-${driveSessionId || 'local'}.csv`);
  else exportGeoJson(rows, `potholeping-session-${driveSessionId || 'local'}.geojson`);
}

async function boot() {
  startBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus('Loading model…');
  onQueueChange(updatePendingUi);
  updatePendingUi(await pendingCount());

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
    scheduleFlush();
  } catch (err) {
    console.error(err);
    setStatus(`Appwrite init failed: ${err.message || err}`, 'err');
  }
}

startBtn.addEventListener('click', startDetecting);
stopBtn.addEventListener('click', () => stopDetecting({ showSummary: true }));
summaryCloseBtn.addEventListener('click', hideSessionSummary);
summaryMapBtn.addEventListener('click', () => {
  window.location.href = '/map.html';
});
summaryCsvBtn?.addEventListener('click', () => exportSession('csv'));
summaryGeoBtn?.addEventListener('click', () => exportSession('geojson'));
window.addEventListener('online', () => {
  scheduleFlush();
});
window.addEventListener('beforeunload', () => stopDetecting({ showSummary: false }));

boot();
