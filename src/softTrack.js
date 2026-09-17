/**
 * Soft temporal tracker for mid-confidence distant detections.
 * A one-off 28% hit is noise; a rising 25→32% track across frames is signal.
 */

import { iou } from './inference.js';

const MATCH_IOU = 0.25;
const SOFT_CONFIRM_N = 4;
const MIN_CONFIRM_CONF = 0.26;

/** @type {{ x1:number,y1:number,x2:number,y2:number,confidence:number,streak:number,lastConf:number,rising:number }[]} */
let tracks = [];

export function resetSoftTracks() {
  tracks = [];
}

/**
 * Update tracks with this frame's soft candidates.
 * @returns {{ ready: object|null, tracks: object[], hasMidConf: boolean }}
 */
export function updateSoftTracks(softCandidates) {
  const hasMidConf = softCandidates.length > 0;
  if (!hasMidConf) {
    // Decay: miss one frame drops streak hard (driving approach should be continuous)
    tracks = tracks
      .map((t) => ({ ...t, streak: t.streak - 1 }))
      .filter((t) => t.streak > 0);
    return { ready: null, tracks, hasMidConf: false };
  }

  const matched = new Array(softCandidates.length).fill(false);
  const next = [];

  for (const track of tracks) {
    let bestIdx = -1;
    let bestIou = MATCH_IOU;
    for (let i = 0; i < softCandidates.length; i++) {
      if (matched[i]) continue;
      const v = iou(track, softCandidates[i]);
      if (v > bestIou) {
        bestIou = v;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const c = softCandidates[bestIdx];
      matched[bestIdx] = true;
      const rising = c.confidence + 0.01 >= track.lastConf ? track.rising + 1 : 0;
      next.push({
        ...c,
        streak: track.streak + 1,
        lastConf: c.confidence,
        rising,
      });
    }
  }

  for (let i = 0; i < softCandidates.length; i++) {
    if (matched[i]) continue;
    const c = softCandidates[i];
    next.push({
      ...c,
      streak: 1,
      lastConf: c.confidence,
      rising: 0,
    });
  }

  tracks = next;

  let ready = null;
  for (const t of tracks) {
    const okStreak = t.streak >= SOFT_CONFIRM_N;
    const okConf = t.confidence >= MIN_CONFIRM_CONF;
    // Prefer rising approaches; allow flat if already fairly confident
    const okTrend = t.rising >= 2 || t.confidence >= 0.32;
    if (okStreak && okConf && okTrend) {
      if (!ready || t.confidence > ready.confidence) ready = t;
    }
  }

  return { ready, tracks, hasMidConf };
}

export { SOFT_CONFIRM_N };
