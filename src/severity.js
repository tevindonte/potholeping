/**
 * Severity proxy score 1–5 from box size, confidence, persistence,
 * and optional physical (accelerometer) verification boost.
 */

/**
 * @param {object} detection - { x1, y1, x2, y2, confidence }
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {number} streak - consecutive confirmation frames
 * @param {{ physicallyVerified?: boolean }} [opts]
 * @returns {number} integer 1–5
 */
export function computeSeverity(
  detection,
  frameWidth,
  frameHeight,
  streak = 3,
  opts = {}
) {
  const boxArea = (detection.x2 - detection.x1) * (detection.y2 - detection.y1);
  const frameArea = frameWidth * frameHeight;
  const areaScore = Math.min(1, boxArea / (frameArea * 0.25));
  const confScore = Math.min(1, Math.max(0, detection.confidence));
  const persistScore = Math.min(1, streak / 5);

  let blended = areaScore * 0.45 + confScore * 0.35 + persistScore * 0.2;
  if (opts.physicallyVerified) {
    blended = Math.min(1, blended + 0.18);
  }
  const score = 1 + blended * 4;
  return Math.max(1, Math.min(5, Math.round(score)));
}

/** CSS / marker color for a 1–5 severity. */
export function severityColor(severity) {
  const colors = {
    1: '#2ecc71',
    2: '#a3d977',
    3: '#f1c40f',
    4: '#e67e22',
    5: '#e74c3c',
  };
  return colors[severity] || colors[3];
}
