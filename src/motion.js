/**
 * Device motion fusion — spike detection for physical pothole verification.
 *
 * Kept deliberately cheap: motion events fire ~60Hz on iOS and will starve
 * camera/inference if we sort/filter on every callback.
 *
 * iOS: DeviceMotionEvent.requestPermission() must run from a user gesture.
 */

const BUFFER_MS = 1200;
const SAMPLE_HZ = 20; // throttle processing to 20Hz
const MIN_SAMPLE_GAP_MS = 1000 / SAMPLE_HZ;
const BASELINE_EVERY_MS = 1000;
const SPIKE_MULT = 2.8;
const MIN_ABS_SPIKE = 2.2; // m/s² above noise floor
const MAX_SAMPLES = 40; // ~2s at 20Hz

let enabled = false;
let samples = []; // { t, mag } — fixed-cap ring via shift
let baseline = 0.35;
let baselineReady = false;
let lastSampleAt = 0;
let lastBaselineAt = 0;
let peakMag = 0;
let peakAt = 0;

function sampleMagnitude(event) {
  const a = event.acceleration;
  const g = event.accelerationIncludingGravity;
  let x;
  let y;
  let z;
  if (a && (a.x != null || a.y != null || a.z != null)) {
    x = a.x || 0;
    y = a.y || 0;
    z = a.z || 0;
  } else if (g) {
    x = g.x || 0;
    y = g.y || 0;
    z = (g.z || 0) - (Math.abs(g.z || 0) > 5 ? Math.sign(g.z || 1) * 9.81 : 0);
  } else {
    return null;
  }
  return Math.sqrt(x * x + y * y + z * z);
}

function onMotion(event) {
  const t = Date.now();
  // Drop most events immediately — biggest win for main-thread budget
  if (t - lastSampleAt < MIN_SAMPLE_GAP_MS) return;
  lastSampleAt = t;

  const mag = sampleMagnitude(event);
  if (mag == null || !Number.isFinite(mag)) return;

  samples.push({ t, mag });
  if (samples.length > MAX_SAMPLES) samples.shift();

  if (mag > peakMag) {
    peakMag = mag;
    peakAt = t;
  }

  // Baseline only once per second, not every event
  if (t - lastBaselineAt < BASELINE_EVERY_MS) return;
  lastBaselineAt = t;

  const cutoff = t - BUFFER_MS * 2;
  // In-place prune without allocating a new filtered array when possible
  let write = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].t >= cutoff) samples[write++] = samples[i];
  }
  samples.length = write;

  if (samples.length < 10) return;

  // Approximate p40 without full sort: partial scan
  const mags = samples.map((s) => s.mag);
  mags.sort((a, b) => a - b);
  const p40 = mags[Math.floor(mags.length * 0.4)];
  baseline = Math.max(0.15, p40);
  baselineReady = true;
}

/** Request iOS permission (no-op / true on Android & desktop). */
export async function requestMotionPermission() {
  try {
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      const result = await DeviceMotionEvent.requestPermission();
      return result === 'granted';
    }
    return typeof DeviceMotionEvent !== 'undefined';
  } catch {
    return false;
  }
}

export function startMotionTracking() {
  if (enabled) return;
  if (typeof window === 'undefined' || !window.DeviceMotionEvent) return;
  lastSampleAt = 0;
  lastBaselineAt = 0;
  peakMag = 0;
  peakAt = 0;
  samples = [];
  window.addEventListener('devicemotion', onMotion, { passive: true });
  enabled = true;
}

export function stopMotionTracking() {
  if (!enabled) return;
  window.removeEventListener('devicemotion', onMotion);
  enabled = false;
  samples = [];
  peakMag = 0;
}

/**
 * True if a sharp motion spike occurred within ±windowMs of timestamp.
 */
export function hadMotionSpikeNear(timestamp = Date.now(), windowMs = 1000) {
  const threshold = Math.max(MIN_ABS_SPIKE, baseline * SPIKE_MULT) + (baselineReady ? baseline : 0);

  // Fast path: recent peak tracker
  if (peakAt >= timestamp - windowMs && peakAt <= timestamp + windowMs && peakMag >= threshold) {
    return true;
  }

  if (!samples.length) return false;
  const from = timestamp - windowMs;
  const to = timestamp + windowMs;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.t >= from && s.t <= to && s.mag >= threshold) return true;
  }
  return false;
}

export function isMotionEnabled() {
  return enabled;
}
