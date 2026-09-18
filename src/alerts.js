/**
 * Heads-up proximity alerts — ahead-only, clustered, optional.
 *
 * - Toggleable on/off
 * - Direction filter using GPS travel bearing (not behind/side)
 * - Clusters nearby ahead pins into one banner
 * - Rate-limits + per-session spatial mute
 */

import { listDetections } from './appwrite.js';
import { unlockFeedback } from './feedback.js';

const ALERT_RADIUS_M = 160;
const SUPPRESS_RADIUS_M = 120;
const CLUSTER_GAP_M = 90;
const AHEAD_HALF_ANGLE_DEG = 65;
const CHECK_MS = 10000;
const FETCH_MS = 45000;
const MIN_ALERT_INTERVAL_MS = 40000;
const MIN_MOVE_M_FOR_HEADING = 4;

/** @type {Set<string>} */
let alertedIds = new Set();
let checkTimer = null;
let fetchTimer = null;
/** @type {{ id: string, lat: number, lng: number, severity: number }[]} */
let cachedPins = [];
let lastFetchAt = 0;
let fetchInFlight = false;
let bannerEl = null;
let onAlert = null;
let getCoordsFn = null;
let checking = false;
let checkGeneration = 0;
let alertsEnabled = true;
let lastAlertAt = 0;
/** @type {{ lat: number, lng: number, t: number } | null} */
let prevFix = null;
let travelHeadingDeg = null;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function toDeg(r) {
  return (r * 180) / Math.PI;
}

/** Haversine distance in meters. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from A→B in degrees [0, 360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDeltaDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export function setAlertsEnabled(on) {
  alertsEnabled = Boolean(on);
  try {
    localStorage.setItem('potholeping_alerts', alertsEnabled ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (!alertsEnabled && bannerEl) bannerEl.hidden = true;
}

export function getAlertsEnabled() {
  return alertsEnabled;
}

export function loadAlertsEnabledPreference() {
  try {
    const v = localStorage.getItem('potholeping_alerts');
    if (v === '0') alertsEnabled = false;
    else if (v === '1') alertsEnabled = true;
  } catch {
    /* ignore */
  }
  return alertsEnabled;
}

function ensureBanner() {
  if (bannerEl) return bannerEl;
  bannerEl = document.createElement('div');
  bannerEl.id = 'proximityBanner';
  bannerEl.className = 'proximity-banner';
  bannerEl.hidden = true;
  document.body.appendChild(bannerEl);
  return bannerEl;
}

function showBanner(text) {
  const el = ensureBanner();
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

function chimeAhead() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.setValueAtTime(780, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    /* ignore */
  }
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

function suppressCluster(lat, lng, primaryId = null) {
  if (primaryId) alertedIds.add(primaryId);
  for (const pin of cachedPins) {
    if (alertedIds.has(pin.id)) continue;
    if (haversineM(lat, lng, pin.lat, pin.lng) <= SUPPRESS_RADIUS_M) {
      alertedIds.add(pin.id);
    }
  }
}

export function suppressAlertAt(lat, lng, rowId = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  suppressCluster(lat, lng, rowId);
}

function updateTravelHeading(coords) {
  const lat = coords.latitude;
  const lng = coords.longitude;
  const t = coords.timestamp || Date.now();
  if (prevFix) {
    const moved = haversineM(prevFix.lat, prevFix.lng, lat, lng);
    if (moved >= MIN_MOVE_M_FOR_HEADING) {
      travelHeadingDeg = bearingDeg(prevFix.lat, prevFix.lng, lat, lng);
      prevFix = { lat, lng, t };
    }
  } else {
    prevFix = { lat, lng, t };
  }
  // Prefer device course when GPS provides it
  if (
    Number.isFinite(coords.heading) &&
    coords.heading >= 0 &&
    coords.accuracy != null &&
    coords.accuracy < 50
  ) {
    travelHeadingDeg = coords.heading;
  }
}

async function refreshCache() {
  if (fetchInFlight) return;
  if (Date.now() - lastFetchAt < FETCH_MS - 500 && cachedPins.length) return;
  fetchInFlight = true;
  try {
    const rows = await listDetections(500);
    const pins = [];
    for (const row of rows) {
      const id = row.$id;
      if (!id) continue;
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      pins.push({
        id,
        lat,
        lng,
        severity: Math.round(Number(row.severity)) || 3,
      });
    }
    cachedPins = pins;

    const muted = [...alertedIds];
    for (const id of muted) {
      const pin = pins.find((p) => p.id === id);
      if (pin) suppressCluster(pin.lat, pin.lng, pin.id);
    }

    lastFetchAt = Date.now();
  } catch (err) {
    console.warn('Proximity fetch failed', err);
  } finally {
    fetchInFlight = false;
  }
}

function collectAheadPins(latitude, longitude, heading) {
  const ahead = [];
  for (const pin of cachedPins) {
    if (alertedIds.has(pin.id)) continue;
    const d = haversineM(latitude, longitude, pin.lat, pin.lng);
    if (d > ALERT_RADIUS_M || d < 3) continue;
    const toPin = bearingDeg(latitude, longitude, pin.lat, pin.lng);
    if (angleDeltaDeg(heading, toPin) > AHEAD_HALF_ANGLE_DEG) continue;
    ahead.push({ pin, d, toPin });
  }
  ahead.sort((a, b) => a.d - b.d);
  return ahead;
}

/** Group ahead pins into one forward cluster (gap-based along approach). */
function clusterAhead(ahead) {
  if (!ahead.length) return null;
  const group = [ahead[0]];
  for (let i = 1; i < ahead.length; i++) {
    const prev = group[group.length - 1];
    if (ahead[i].d - prev.d <= CLUSTER_GAP_M) group.push(ahead[i]);
    else break;
  }
  const nearest = group[0];
  const worst = group.reduce((a, b) =>
    a.pin.severity >= b.pin.severity ? a : b
  );
  return { group, nearest, worst };
}

function formatClusterMessage(cluster) {
  const n = cluster.group.length;
  const dist = Math.round(cluster.nearest.d);
  const sev = cluster.worst.pin.severity;
  if (n === 1) {
    return `Pothole ahead · ~${dist}m · S${sev}`;
  }
  return `${n} potholes ahead · nearest ~${dist}m · worst S${sev}`;
}

function runDistanceCheck() {
  if (!alertsEnabled || checking) return;
  const coords = getCoordsFn?.();
  if (!coords || !cachedPins.length) return;

  updateTravelHeading(coords);
  if (travelHeadingDeg == null) return; // wait until we know direction of travel

  if (Date.now() - lastAlertAt < MIN_ALERT_INTERVAL_MS) return;

  checking = true;
  const gen = ++checkGeneration;
  const { latitude, longitude } = coords;
  const heading = travelHeadingDeg;

  scheduleIdle(() => {
    try {
      if (gen !== checkGeneration || !alertsEnabled) return;

      const ahead = collectAheadPins(latitude, longitude, heading);
      const cluster = clusterAhead(ahead);
      if (!cluster) return;

      // Mute every pin in the cluster (and neighbors) before sounding
      for (const item of cluster.group) {
        suppressCluster(item.pin.lat, item.pin.lng, item.pin.id);
      }

      lastAlertAt = Date.now();
      showBanner(formatClusterMessage(cluster));
      chimeAhead();
      if (typeof onAlert === 'function') onAlert(cluster);
    } finally {
      if (gen === checkGeneration) checking = false;
    }
  });
}

export function startProximityAlerts(getCoords, opts = {}) {
  stopProximityAlerts();
  alertedIds = new Set();
  checkGeneration = 0;
  lastAlertAt = 0;
  prevFix = null;
  travelHeadingDeg = null;
  onAlert = opts.onAlert || null;
  getCoordsFn = getCoords;
  unlockFeedback();
  ensureBanner();

  if (!alertsEnabled) return;

  scheduleIdle(() => {
    refreshCache();
  });

  fetchTimer = setInterval(() => {
    scheduleIdle(() => {
      if (alertsEnabled) refreshCache();
    });
  }, FETCH_MS);

  checkTimer = setInterval(() => {
    runDistanceCheck();
  }, CHECK_MS);

  setTimeout(() => runDistanceCheck(), 2500);
}

export function stopProximityAlerts() {
  checkGeneration += 1;
  checking = false;
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
  if (bannerEl) bannerEl.hidden = true;
  getCoordsFn = null;
}

export function clearAlertMemory() {
  alertedIds = new Set();
}
