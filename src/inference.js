/**
 * ONNX Runtime session + YOLOv8n preprocess / NMS postprocess.
 * Model input:  (1, 3, 640, 640) BCHW
 * Model output: (1, 5, 8400) — raw, not NMS'd (cx, cy, w, h, conf)
 */

import * as ort from 'onnxruntime-web';

const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.45;

let session = null;

export async function loadModel() {
  // Extern WASM served from /ort/ (see vite-plugin-static-copy)
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
 * Letterbox resize to 640x640, return float32 CHW tensor + scale metadata
 * so boxes can be mapped back to the original frame.
 */
export function preprocess(source) {
  const srcW = source.videoWidth || source.width;
  const srcH = source.videoHeight || source.height;

  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, padX, padY, newW, newH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;

  for (let i = 0; i < plane; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    float32[i] = r;
    float32[plane + i] = g;
    float32[2 * plane + i] = b;
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  return { tensor, scale, padX, padY, srcW, srcH };
}

function iou(a, b) {
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
 * Parse raw YOLOv8 output (1, 5, 8400) into boxes in original image coords.
 */
export function postprocess(output, meta, confThresh = CONF_THRESHOLD) {
  const data = output.data;
  // dims: [1, 5, 8400]
  const numPreds = output.dims[2]; // 8400
  const { scale, padX, padY, srcW, srcH } = meta;

  const candidates = [];
  for (let i = 0; i < numPreds; i++) {
    const conf = data[4 * numPreds + i];
    if (conf < confThresh) continue;

    const cx = data[0 * numPreds + i];
    const cy = data[1 * numPreds + i];
    const w = data[2 * numPreds + i];
    const h = data[3 * numPreds + i];

    // Undo letterbox → original frame pixels
    let x1 = (cx - w / 2 - padX) / scale;
    let y1 = (cy - h / 2 - padY) / scale;
    let x2 = (cx + w / 2 - padX) / scale;
    let y2 = (cy + h / 2 - padY) / scale;

    x1 = Math.max(0, Math.min(srcW, x1));
    y1 = Math.max(0, Math.min(srcH, y1));
    x2 = Math.max(0, Math.min(srcW, x2));
    y2 = Math.max(0, Math.min(srcH, y2));

    if (x2 <= x1 || y2 <= y1) continue;

    candidates.push({ x1, y1, x2, y2, confidence: conf });
  }

  return nms(candidates);
}

/**
 * Run one inference cycle on a video/image source.
 * Returns array of { x1, y1, x2, y2, confidence }.
 */
export async function detect(source) {
  if (!session) throw new Error('Model not loaded');

  const { tensor, ...meta } = preprocess(source);
  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: tensor });
  const output = results[session.outputNames[0]];
  return postprocess(output, meta);
}

export { CONF_THRESHOLD, INPUT_SIZE };
