/**
 * Heads-up proximity alerts for nearby previously logged potholes.
 */

import { listDetections } from './appwrite.js';
import { unlockFeedback } from './feedback.js';

const ALERT_RADIUS_M = 125;
const POLL_MS = 8000;

let alertedIds = new Set();
let pollTimer = null;
let cachedRows = [];
let lastFetchAt = 0;
let bannerEl = null;
let onAlert = null;

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

async function refreshCache() {
  if (Date.now() - lastFetchAt < POLL_MS - 500) return;
  try {
    cachedRows = await listDetections(500);
    lastFetchAt = Date.now();
  } catch (err) {
    console.warn('Proximity fetch failed', err);
  }
}

async function checkPosition(coords) {
  if (!coords) return;
  await refreshCache();
  const near = [];
  for (const row of cachedRows) {
    const id = row.$id;
    if (!id || alertedIds.has(id)) continue;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const d = haversineM(coords.latitude, coords.longitude, lat, lng);
    if (d <= ALERT_RADIUS_M) near.push({ row, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (!near.length) return;

  const hit = near[0];
  alertedIds.add(hit.row.$id);
  const sev = Math.round(Number(hit.row.severity)) || 3;
  const msg = `Pothole reported ahead · ~${Math.round(hit.d)}m · S${sev}`;
  showBanner(msg);
  chimeAhead();
  if (typeof onAlert === 'function') onAlert(hit);
}

export function startProximityAlerts(getCoords, opts = {}) {
  stopProximityAlerts();
  alertedIds = new Set();
  onAlert = opts.onAlert || null;
  unlockFeedback();
  ensureBanner();
  pollTimer = setInterval(() => {
    checkPosition(getCoords());
  }, POLL_MS);
  // First check soon after start
  setTimeout(() => checkPosition(getCoords()), 1500);
}

export function stopProximityAlerts() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (bannerEl) bannerEl.hidden = true;
}

export function clearAlertMemory() {
  alertedIds = new Set();
}
