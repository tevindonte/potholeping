/**
 * Device motion fusion — spike detection for physical pothole verification.
 *
 * iOS: DeviceMotionEvent.requestPermission() must run from a user gesture.
 */

const BUFFER_MS = 1000;
const SPIKE_MULT = 2.8;
const MIN_ABS_SPIKE = 2.2; // m/s² above noise floor

let enabled = false;
let samples = []; // { t, mag }
let baseline = 0.35;
let baselineReady = false;

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
    // Roughly remove gravity by using deviation from ~9.8 on dominant axis
    x = g.x || 0;
    y = g.y || 0;
    z = (g.z || 0) - (Math.abs(g.z || 0) > 5 ? Math.sign(g.z || 1) * 9.81 : 0);
  } else {
    return null;
  }
  return Math.sqrt(x * x + y * y + z * z);
}

function onMotion(event) {
  const mag = sampleMagnitude(event);
  if (mag == null || !Number.isFinite(mag)) return;
  const t = Date.now();
  samples.push({ t, mag });
  const cutoff = t - BUFFER_MS * 3;
  samples = samples.filter((s) => s.t >= cutoff);

  // Adaptive noise floor from quieter samples
  const recent = samples.filter((s) => s.t >= t - 3000);
  if (recent.length >= 15) {
    const sorted = recent.map((s) => s.mag).sort((a, b) => a - b);
    const p40 = sorted[Math.floor(sorted.length * 0.4)];
    baseline = Math.max(0.15, p40);
    baselineReady = true;
  }
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
  window.addEventListener('devicemotion', onMotion, { passive: true });
  enabled = true;
}

export function stopMotionTracking() {
  if (!enabled) return;
  window.removeEventListener('devicemotion', onMotion);
  enabled = false;
  samples = [];
}

/**
 * True if a sharp motion spike occurred within ±windowMs of timestamp.
 */
export function hadMotionSpikeNear(timestamp = Date.now(), windowMs = 1000) {
  if (!samples.length) return false;
  const threshold = Math.max(MIN_ABS_SPIKE, baseline * SPIKE_MULT);
  const from = timestamp - windowMs;
  const to = timestamp + windowMs;
  return samples.some(
    (s) => s.t >= from && s.t <= to && s.mag >= threshold + (baselineReady ? baseline : 0)
  );
}

export function isMotionEnabled() {
  return enabled;
}
