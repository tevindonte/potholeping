/**
 * On-device ONNX model catalog for A/B comparison.
 * v2 = current production weights (best.onnx).
 * v3 = next training run (best_v3.onnx) — upload when ready.
 */

export const DEFAULT_MODEL_VERSION = 'v2';

/** @type {Record<string, { id: string, label: string, file: string }>} */
export const MODEL_CATALOG = {
  v2: {
    id: 'v2',
    label: 'v2 (production)',
    file: 'best.onnx',
  },
  v3: {
    id: 'v3',
    label: 'v3',
    file: 'best_v3.onnx',
  },
};

export function listModels() {
  return Object.values(MODEL_CATALOG);
}

export function getModelEntry(version) {
  return MODEL_CATALOG[version] || MODEL_CATALOG[DEFAULT_MODEL_VERSION];
}

export function modelPath(version) {
  const entry = getModelEntry(version);
  const base = import.meta.env.BASE_URL || '/';
  return `${base}models/${entry.file}`;
}
