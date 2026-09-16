/**
 * Severity proxy score 1–5 from box size, confidence, and confirmation streak.
 *
 * No depth data from a single camera, so this is a heuristic:
 * - Larger relative box area → closer / bigger pothole
 * - Higher model confidence → more certain detection
 * - Longer consecutive persistence → less likely noise
 */

/**
 * @param {object} detection - { x1, y1, x2, y2, confidence }
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {number} streak - consecutive confirmation frames (already met N)
 * @returns {number} integer 1–5
 */
export function computeSeverity(detection, frameWidth, frameHeight, streak = 3) {
  const boxArea = (detection.x2 - detection.x1) * (detection.y2 - detection.y1);
  const frameArea = frameWidth * frameHeight;
  // Cap relative area — a box covering >25% of frame is already "large"
  const areaScore = Math.min(1, boxArea / (frameArea * 0.25));
  const confScore = Math.min(1, Math.max(0, detection.confidence));
  // streak of 3 → 0.6, 5+ → 1.0
  const persistScore = Math.min(1, streak / 5);

  const blended = areaScore * 0.45 + confScore * 0.35 + persistScore * 0.2;
  // Map 0–1 → 1–5
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
