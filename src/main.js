/**
 * Camera feed + live detection loop + offline queue + motion + alerts.
 */

import './style.css';
import { loadModel, inferFrame, CONF_THRESHOLD, getInputSize, getActiveModelVersion } from './inference.js';
import { listModels, DEFAULT_MODEL_VERSION } from './models.js';
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
import { startProximityAlerts, stopProximityAlerts, suppressAlertAt } from './alerts.js';
import { acquireWakeLock, releaseWakeLock } from './wake.js';
import { updateSoftTracks, resetSoftTracks } from './softTrack.js';

const INFER_INTERVAL_MS = 250;
const INFER_INTERVAL_FAST_MS = 150;
const CONFIRM_N = 3;
const COOLDOWN_MS = 9000;
const JPEG_QUALITY = 0.72;
const DEBUG_CONF = 0.15;

/** Temporary diagnostic: ?debug=1 or localStorage potholeping_debug=1 */
function isDebugMode() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('debug') === '1' || q.get('debug') === 'true') return true;
    if (localStorage.getItem('potholeping_debug') === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

let debugMode = isDebugMode();
let debugTick = 0;
let inferIntervalMs = INFER_INTERVAL_MS;

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
const modelSelect = document.getElementById('modelSelect');

function populateModelSelect() {
  if (!modelSelect) return;
  modelSelect.innerHTML = '';
  for (const m of listModels()) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === DEFAULT_MODEL_VERSION) opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

function selectedModelVersion() {
  return modelSelect?.value || getActiveModelVersion() || DEFAULT_MODEL_VERSION;
}

async function switchModel(version) {
  const target = version || DEFAULT_MODEL_VERSION;
  if (running) {
    setStatus('Stop detecting before switching models', 'warn');
    if (modelSelect) modelSelect.value = getActiveModelVersion();
    return;
  }
  if (modelSelect) modelSelect.disabled = true;
  setStatus(`Loading model ${target}…`);
  try {
    await loadModel(target);
    setStatus(`Model ${getActiveModelVersion()} ready · imgsz ${getInputSize()}`);
  } catch (err) {
    console.error(err);
    const hint =
      target === 'v3'
        ? ' Upload public/models/best_v3.onnx then redeploy.'
        : target === 'v1'
          ? ' Missing public/models/best_v1.onnx.'
          : '';
    setStatus(`Failed to load ${target}: ${err.message || err}.${hint}`, 'err');
    if (modelSelect) modelSelect.value = getActiveModelVersion();
    if (target !== DEFAULT_MODEL_VERSION) {
      try {
        await loadModel(DEFAULT_MODEL_VERSION);
        if (modelSelect) modelSelect.value = DEFAULT_MODEL_VERSION;
        setStatus(`Fell back to ${DEFAULT_MODEL_VERSION} (production)`, 'warn');
      } catch (e2) {
        console.error(e2);
      }
    }
  } finally {
    if (modelSelect) modelSelect.disabled = false;
  }
}

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

function drawDetections(detections, rawDebug = null) {
  syncCanvasSize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Debug-only: raw pre-NMS candidates at low threshold (dashed, does not log)
  if (debugMode && rawDebug?.length) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = Math.max(1.5, overlay.width / 320);
    ctx.font = `${Math.max(10, overlay.width / 48)}px "DM Sans", sans-serif`;
    for (const det of rawDebug) {
      const w = det.x2 - det.x1;
      const h = det.y2 - det.y1;
      const belowProd = det.confidence < CONF_THRESHOLD;
      ctx.strokeStyle = belowProd ? 'rgba(100, 200, 255, 0.85)' : 'rgba(255, 180, 60, 0.9)';
      ctx.strokeRect(det.x1, det.y1, w, h);
      const label = `${(det.confidence * 100).toFixed(0)}% ${Math.round(w)}×${Math.round(h)}`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(label, det.x1 + 2, Math.max(12, det.y1 - 4));
    }
    ctx.restore();
  }

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
    ctx.setLineDash([]);
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

function updateDebugHud(rawDebug, detections) {
  const hud = document.getElementById('debugHud');
  if (!hud) return;
  if (!debugMode) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  const raw = rawDebug || [];
  const below = raw.filter((d) => d.confidence < CONF_THRESHOLD);
  const lines = raw
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12)
    .map((d) => {
      const mark = d.confidence >= CONF_THRESHOLD ? '✓' : '·';
      return `${mark} ${(d.confidence * 100).toFixed(1)}%  ${Math.round(d.width)}×${Math.round(d.height)}px  [${Math.round(d.x1)},${Math.round(d.y1)}]`;
    });
  hud.innerHTML = `<strong>DEBUG raw ≥${(DEBUG_CONF * 100).toFixed(0)}% (pre-NMS)</strong>
    <div>prod keeps ≥${(CONF_THRESHOLD * 100).toFixed(0)}% + NMS · logging unchanged</div>
    <div>raw ${raw.length} · below-prod ${below.length} · prod ${detections.length}</div>
    <pre>${lines.join('\n') || '(no candidates)'}</pre>`;
}

function logDebugCandidates(rawDebug) {
  if (!rawDebug?.length) return;
  debugTick += 1;
  // Throttle console spam; still every tick when something appears below prod threshold
  const interesting = rawDebug.filter((d) => d.confidence < CONF_THRESHOLD);
  if (interesting.length === 0 && debugTick % 8 !== 0) return;
  const payload = rawDebug
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20)
    .map((d) => ({
      conf: Number(d.confidence.toFixed(3)),
      w: Math.round(d.width),
      h: Math.round(d.height),
      x1: Math.round(d.x1),
      y1: Math.round(d.y1),
      x2: Math.round(d.x2),
      y2: Math.round(d.y2),
    }));
  console.log(`[debug raw conf≥${DEBUG_CONF}]`, payload);
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
    modelVersion: entry.modelVersion || getActiveModelVersion(),
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
      modelVersion: getActiveModelVersion(),
    };

    // Always queue first so offline never loses a detection
    await enqueueDetection(entry);

    lastLoggedAt = Date.now();
    streak = 0;
    loggedCount += 1;
    sessionLogs.push({ ...entry, blob: undefined });
    logCountEl.textContent = String(loggedCount);
    pingLogged();
    // Don't proximity-chime for a pin we just logged ourselves
    suppressAlertAt(coords.latitude, coords.longitude);

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

function ensureInferTimer(intervalMs) {
  if (!running) return;
  if (inferTimer && intervalMs === inferIntervalMs) return;
  inferIntervalMs = intervalMs;
  if (inferTimer) clearInterval(inferTimer);
  inferTimer = setInterval(inferenceTick, inferIntervalMs);
}

async function inferenceTick() {
  if (!running || video.readyState < 2 || inferBusy) return;
  inferBusy = true;

  try {
    const { detections, softCandidates, rawDebug } = await inferFrame(video, {
      includeRawDebug: debugMode,
      debugThresh: DEBUG_CONF,
    });
    drawDetections(detections, rawDebug);
    if (debugMode) {
      updateDebugHud(rawDebug, detections);
      logDebugCandidates(rawDebug);
    }

    const inCooldown = Date.now() - lastLoggedAt < COOLDOWN_MS;
    const soft = updateSoftTracks(softCandidates || []);

    // Speed up only while a mid-conf approach is in flight
    ensureInferTimer(soft.hasMidConf ? INFER_INTERVAL_FAST_MS : INFER_INTERVAL_MS);

    if (!inCooldown && !logging) {
      if (detections.length > 0) {
        streak += 1;
        setStatus(`Detecting… streak ${streak}/${CONFIRM_N}`);
        if (streak >= CONFIRM_N) {
          const best = detections.reduce((a, b) =>
            a.confidence >= b.confidence ? a : b
          );
          await confirmAndLog(best);
        }
      } else if (soft.ready) {
        streak = 0;
        setStatus(
          `Soft-confirm distant · ${(soft.ready.confidence * 100).toFixed(0)}% · streak ${soft.ready.streak}`,
          'ok'
        );
        await confirmAndLog(soft.ready);
        resetSoftTracks();
      } else if (soft.hasMidConf) {
        streak = 0;
        const bestSoft = soft.tracks.reduce((a, b) =>
          a.confidence >= b.confidence ? a : b
        );
        setStatus(
          `Tracking distant… ${(bestSoft.confidence * 100).toFixed(0)}% · soft ${bestSoft.streak}/4`
        );
      } else {
        streak = 0;
        if (running) setStatus('Scanning for potholes…');
      }
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
  // Keep screen on so iOS doesn't dim mid-drive and kill the camera
  await acquireWakeLock();

  try {
    await startCamera();
    driveSessionId = createSessionId();
    sessionStartedAt = Date.now();
    sessionLogs = [];
    streak = 0;
    lastLoggedAt = 0;
    loggedCount = 0;
    logCountEl.textContent = '0';
    resetSoftTracks();
    running = true;
    stopBtn.disabled = false;
    startProximityAlerts(() => lastCoords);
    const imgsz = getInputSize();
    setStatus(
      `Scanning · ${getActiveModelVersion()} · imgsz ${imgsz}${motionOk ? ' · motion on' : ''} — tip: angle mount up to cut hood from frame`
    );
    if (modelSelect) modelSelect.disabled = true;
    inferIntervalMs = 0; // force timer recreate
    ensureInferTimer(INFER_INTERVAL_MS);
  } catch (err) {
    console.error(err);
    setStatus(`Camera error: ${err.message || err}`, 'err');
    startBtn.disabled = false;
    if (modelSelect) modelSelect.disabled = false;
    stopMotionTracking();
    stopProximityAlerts();
    releaseWakeLock();
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
  releaseWakeLock();
  resetSoftTracks();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (modelSelect) modelSelect.disabled = false;
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
  populateModelSelect();
  setStatus('Loading model…');
  onQueueChange(updatePendingUi);
  updatePendingUi(await pendingCount());

  try {
    await loadModel(selectedModelVersion());
  } catch (err) {
    console.error(err);
    setStatus(`Model init failed: ${err.message || err}`, 'err');
    return;
  }

  try {
    await ensureSession();
    const imgsz = getInputSize();
    setStatus(
      `Ready · ${getActiveModelVersion()} · imgsz ${imgsz} — tip: raise/angle mount to minimize hood. Use ?imgsz=960 to trial higher res.`
    );
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
modelSelect?.addEventListener('change', () => {
  switchModel(modelSelect.value);
});
summaryCloseBtn.addEventListener('click', hideSessionSummary);
summaryMapBtn.addEventListener('click', () => {
  window.location.href = '/map.html';
});
summaryCsvBtn?.addEventListener('click', () => exportSession('csv'));
summaryGeoBtn?.addEventListener('click', () => exportSession('geojson'));

const debugToggleBtn = document.getElementById('debugToggle');
function syncDebugToggleUi() {
  if (!debugToggleBtn) return;
  debugToggleBtn.dataset.on = debugMode ? '1' : '0';
  debugToggleBtn.textContent = debugMode ? 'Debug ON' : 'Debug';
  const hud = document.getElementById('debugHud');
  if (hud && !debugMode) hud.hidden = true;
  if (debugMode) {
    setStatus(`Debug mode — raw ≥${(DEBUG_CONF * 100).toFixed(0)}% overlay (logging still ≥${(CONF_THRESHOLD * 100).toFixed(0)}%)`, 'warn');
  }
}
debugToggleBtn?.addEventListener('click', () => {
  debugMode = !debugMode;
  try {
    localStorage.setItem('potholeping_debug', debugMode ? '1' : '0');
  } catch {
    /* ignore */
  }
  syncDebugToggleUi();
});
syncDebugToggleUi();

window.addEventListener('online', () => {
  scheduleFlush();
});
window.addEventListener('beforeunload', () => stopDetecting({ showSummary: false }));

boot();
