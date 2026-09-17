/**
 * Heads-up proximity alerts for nearby previously logged potholes.
 *
 * Split fetch vs distance-check so we never hit Appwrite on the hot path
 * and keep haversine work off the inference cadence via requestIdleCallback.
 */

import { listDetections } from './appwrite.js';
import { unlockFeedback } from './feedback.js';

const ALERT_RADIUS_M = 125;
const CHECK_MS = 10000;
const FETCH_MS = 45000;

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

function toRad(d) {
  return (d * Math.PI) / 180;
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
  }, 3500);
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

async function refreshCache() {
  if (fetchInFlight) return;
  if (Date.now() - lastFetchAt < FETCH_MS - 500 && cachedPins.length) return;
  fetchInFlight = true;
  try {
    const rows = await listDetections(500);
    // Pre-parse numbers once so checks stay cheap
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
    lastFetchAt = Date.now();
  } catch (err) {
    console.warn('Proximity fetch failed', err);
  } finally {
    fetchInFlight = false;
  }
}

function runDistanceCheck() {
  if (checking) return;
  const coords = getCoordsFn?.();
  if (!coords || !cachedPins.length) return;

  checking = true;
  scheduleIdle(() => {
    try {
      let best = null;
      const { latitude, longitude } = coords;
      for (let i = 0; i < cachedPins.length; i++) {
        const pin = cachedPins[i];
        if (alertedIds.has(pin.id)) continue;
        const d = haversineM(latitude, longitude, pin.lat, pin.lng);
        if (d <= ALERT_RADIUS_M && (!best || d < best.d)) {
          best = { pin, d };
        }
      }
      if (!best) return;

      alertedIds.add(best.pin.id);
      const msg = `Pothole reported ahead · ~${Math.round(best.d)}m · S${best.pin.severity}`;
      showBanner(msg);
      chimeAhead();
      if (typeof onAlert === 'function') onAlert(best);
    } finally {
      checking = false;
    }
  });
}

export function startProximityAlerts(getCoords, opts = {}) {
  stopProximityAlerts();
  alertedIds = new Set();
  onAlert = opts.onAlert || null;
  getCoordsFn = getCoords;
  unlockFeedback();
  ensureBanner();

  // Warm cache in the background — never blocks Start Detecting
  scheduleIdle(() => {
    refreshCache();
  });

  fetchTimer = setInterval(() => {
    scheduleIdle(() => {
      refreshCache();
    });
  }, FETCH_MS);

  checkTimer = setInterval(() => {
    runDistanceCheck();
  }, CHECK_MS);

  setTimeout(() => runDistanceCheck(), 2500);
}

export function stopProximityAlerts() {
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
