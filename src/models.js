/**
 * On-device ONNX model catalog for A/B comparison.
 * v1 = original Cycle 3 weights
 * v2 = current production (expanded dataset / night + manhole fixes)
 * v3 = scale-augmentation retrain
 */

export const DEFAULT_MODEL_VERSION = 'v2';

/** @type {Record<string, { id: string, label: string, file: string }>} */
export const MODEL_CATALOG = {
  v1: {
    id: 'v1',
    label: 'v1 (Cycle 3)',
    file: 'best_v1.onnx',
  },
  v2: {
    id: 'v2',
    label: 'v2 (production)',
    file: 'best.onnx',
  },
  v3: {
    id: 'v3',
    label: 'v3 (scale aug)',
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
