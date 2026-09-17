/**
 * ONNX Runtime session + YOLOv8n preprocess / NMS postprocess.
 * Model is fully convolutional — imgsz 640 (default) or 960 (trial via setInputSize).
 * Output anchors scale with imgsz; postprocess reads dims dynamically.
 */

import * as ort from 'onnxruntime-web';

let INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.45;
/** Soft path: mid-confidence distant boxes (below prod, above noise floor). */
const SOFT_CONF_MIN = 0.22;
const IOU_THRESHOLD = 0.45;
/** Box area / frame area below this ≈ distant/small — eligible for soft path. */
const SMALL_BOX_FRAC = 0.05;

let session = null;

export function getInputSize() {
  return INPUT_SIZE;
}

/** Allowed sizes are multiples of 32. Returns the applied size. */
export function setInputSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 320 || n > 1280) return INPUT_SIZE;
  INPUT_SIZE = Math.round(n / 32) * 32;
  return INPUT_SIZE;
}

export function resolveInputSizeFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    const fromQ = q.get('imgsz');
    const fromLs = localStorage.getItem('potholeping_imgsz');
    if (fromQ) return setInputSize(fromQ);
    if (fromLs) return setInputSize(fromLs);
  } catch {
    /* ignore */
  }
  return INPUT_SIZE;
}

export async function loadModel() {
  resolveInputSizeFromUrl();
  const base = import.meta.env.BASE_URL || '/';
  ort.env.wasm.wasmPaths = `${base}ort/`;
  ort.env.wasm.numThreads = 1;

  session = await ort.InferenceSession.create(
    `${import.meta.env.BASE_URL}models/best.onnx`,
    { executionProviders: ['wasm'] }
  );
  return session;
}

/**
 * Letterbox resize to INPUT_SIZE², return float32 CHW tensor + scale metadata.
 */
export function preprocess(source) {
  const srcW = source.videoWidth || source.width;
  const srcH = source.videoHeight || source.height;
  const size = INPUT_SIZE;

  const scale = Math.min(size / srcW, size / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = (size - newW) / 2;
  const padY = (size - newH) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, padX, padY, newW, newH);

  const { data } = ctx.getImageData(0, 0, size, size);
  const float32 = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let i = 0; i < plane; i++) {
    float32[i] = data[i * 4] / 255;
    float32[plane + i] = data[i * 4 + 1] / 255;
    float32[2 * plane + i] = data[i * 4 + 2] / 255;
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, size, size]);
  return { tensor, scale, padX, padY, srcW, srcH };
}

export function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(boxes, iouThresh = IOU_THRESHOLD) {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  const suppressed = new Array(boxes.length).fill(false);

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed[i]) continue;
    kept.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (!suppressed[j] && iou(boxes[i], boxes[j]) > iouThresh) {
        suppressed[j] = true;
      }
    }
  }
  return kept;
}

/**
 * Parse raw YOLOv8 output into boxes in original image coords.
 */
export function postprocess(output, meta, confThresh = CONF_THRESHOLD, applyNms = true) {
  const data = output.data;
  const numPreds = output.dims[2];
  const { scale, padX, padY, srcW, srcH } = meta;
  const frameArea = srcW * srcH;

  const candidates = [];
  for (let i = 0; i < numPreds; i++) {
    const conf = data[4 * numPreds + i];
    if (conf < confThresh) continue;

    const cx = data[0 * numPreds + i];
    const cy = data[1 * numPreds + i];
    const w = data[2 * numPreds + i];
    const h = data[3 * numPreds + i];

    let x1 = (cx - w / 2 - padX) / scale;
    let y1 = (cy - h / 2 - padY) / scale;
    let x2 = (cx + w / 2 - padX) / scale;
    let y2 = (cy + h / 2 - padY) / scale;

    x1 = Math.max(0, Math.min(srcW, x1));
    y1 = Math.max(0, Math.min(srcH, y1));
    x2 = Math.max(0, Math.min(srcW, x2));
    y2 = Math.max(0, Math.min(srcH, y2));

    if (x2 <= x1 || y2 <= y1) continue;

    const bw = x2 - x1;
    const bh = y2 - y1;
    const areaFrac = (bw * bh) / (frameArea + 1e-6);
    candidates.push({
      x1,
      y1,
      x2,
      y2,
      confidence: conf,
      width: bw,
      height: bh,
      areaFrac,
    });
  }

  return applyNms ? nms(candidates) : candidates;
}

/**
 * Soft-path candidates: mid-confidence AND small/distant boxes only.
 * Size-aware — large mid-conf blobs (patches/stains) stay excluded.
 */
export function softCandidatesFrom(rawOrLowThresh, frameArea) {
  return nms(
    rawOrLowThresh.filter((d) => {
      const frac =
        d.areaFrac ??
        ((d.x2 - d.x1) * (d.y2 - d.y1)) / (frameArea + 1e-6);
      return (
        d.confidence >= SOFT_CONF_MIN &&
        d.confidence < CONF_THRESHOLD &&
        frac <= SMALL_BOX_FRAC
      );
    })
  );
}

/**
 * One model forward.
 * detections = hard path (≥0.45 + NMS)
 * softCandidates = small mid-conf boxes for temporal streak
 * rawDebug = optional pre-NMS dump for diagnostic overlay
 */
export async function inferFrame(
  source,
  { includeRawDebug = false, debugThresh = 0.15 } = {}
) {
  if (!session) throw new Error('Model not loaded');

  const { tensor, ...meta } = preprocess(source);
  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: tensor });
  const output = results[session.outputNames[0]];

  const detections = postprocess(output, meta, CONF_THRESHOLD, true);
  // One low pass for soft path (+ debug if needed)
  const lowPass = postprocess(output, meta, SOFT_CONF_MIN, false);
  const softCandidates = softCandidatesFrom(
    lowPass,
    meta.srcW * meta.srcH
  );
  const rawDebug = includeRawDebug
    ? postprocess(output, meta, debugThresh, false)
    : null;

  return { detections, softCandidates, rawDebug, meta };
}

export async function detect(source) {
  const { detections } = await inferFrame(source);
  return detections;
}

export const DEBUG_CONF_THRESHOLD = 0.15;
export {
  CONF_THRESHOLD,
  SOFT_CONF_MIN,
  SMALL_BOX_FRAC,
  INPUT_SIZE,
};
