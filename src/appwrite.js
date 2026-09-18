/**
 * Appwrite client: anonymous session, upload, spatial re-confirm / create.
 */

import { Client, Account, Storage, TablesDB, ID, Query } from 'appwrite';

const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID);

const account = new Account(client);
const storage = new Storage(client);
const tablesDB = new TablesDB(client);

const DATABASE_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID;
const TABLE_ID = import.meta.env.VITE_APPWRITE_TABLE_ID;
const BUCKET_ID = import.meta.env.VITE_APPWRITE_BUCKET_ID;

/** ~15m latitude buffer; lng scaled by cos(lat). */
const BBOX_LAT_DEG = 0.00015;
const MERGE_RADIUS_M = 15;
/** Same sessionId within this window → never merge (adjacent holes). */
const SAME_SESSION_WINDOW_MS = 90_000;

let ready = false;
let supportsPhysicallyVerified = true;
let supportsModelVersion = true;
let supportsConfirmCount = true;
let supportsLastConfirmedAt = true;

export async function ensureSession() {
  if (ready) return;
  try {
    await account.get();
    ready = true;
  } catch {
    await account.createAnonymousSession();
    ready = true;
  }
}

export function createSessionId() {
  return ID.unique();
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildRowData({
  latitude,
  longitude,
  severity,
  confidence,
  imageId,
  sessionId,
  createdAt,
  physicallyVerified,
  modelVersion,
  confirmCount,
  lastConfirmedAt,
}) {
  const nowIso = createdAt || new Date().toISOString();
  const data = {
    latitude,
    longitude,
    severity,
    confidence,
    imageId,
    sessionId,
    createdAt: nowIso,
  };
  if (supportsPhysicallyVerified) {
    data.physicallyVerified = Boolean(physicallyVerified);
  }
  if (supportsModelVersion && modelVersion) {
    data.modelVersion = String(modelVersion);
  }
  if (supportsConfirmCount) {
    data.confirmCount = Number.isFinite(confirmCount) ? confirmCount : 1;
  }
  if (supportsLastConfirmedAt) {
    data.lastConfirmedAt = lastConfirmedAt || nowIso;
  }
  return data;
}

function markUnsupportedFromError(msg) {
  let changed = false;
  if (
    supportsPhysicallyVerified &&
    /physicallyVerified|Unknown attribute|Invalid document/i.test(msg)
  ) {
    supportsPhysicallyVerified = false;
    changed = true;
  }
  if (
    supportsModelVersion &&
    /modelVersion|Unknown attribute|Invalid document/i.test(msg)
  ) {
    supportsModelVersion = false;
    changed = true;
  }
  if (
    supportsConfirmCount &&
    /confirmCount|Unknown attribute|Invalid document/i.test(msg)
  ) {
    supportsConfirmCount = false;
    changed = true;
  }
  if (
    supportsLastConfirmedAt &&
    /lastConfirmedAt|Unknown attribute|Invalid document/i.test(msg)
  ) {
    supportsLastConfirmedAt = false;
    changed = true;
  }
  return changed;
}

async function createRowWithFallback(fields) {
  const attempt = () =>
    tablesDB.createRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId: ID.unique(),
      data: buildRowData(fields),
    });

  try {
    return await attempt();
  } catch (err) {
    if (markUnsupportedFromError(String(err?.message || err))) {
      return attempt();
    }
    throw err;
  }
}

async function updateRowWithFallback(rowId, data) {
  const attempt = (payload) =>
    tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      rowId,
      data: payload,
    });

  try {
    return await attempt(data);
  } catch (err) {
    const msg = String(err?.message || err);
    if (!markUnsupportedFromError(msg)) throw err;
    const cleaned = { ...data };
    if (!supportsPhysicallyVerified) delete cleaned.physicallyVerified;
    if (!supportsModelVersion) delete cleaned.modelVersion;
    if (!supportsConfirmCount) delete cleaned.confirmCount;
    if (!supportsLastConfirmedAt) delete cleaned.lastConfirmedAt;
    return attempt(cleaned);
  }
}

/** Bounding-box query then Haversine filter to MERGE_RADIUS_M. */
export async function findNearbyPins(latitude, longitude, radiusM = MERGE_RADIUS_M) {
  await ensureSession();
  const lat = Number(latitude);
  const lng = Number(longitude);
  const cos = Math.max(0.2, Math.cos(toRad(lat)));
  const latDelta = BBOX_LAT_DEG;
  const lngDelta = BBOX_LAT_DEG / cos;

  try {
    const response = await tablesDB.listRows({
      databaseId: DATABASE_ID,
      tableId: TABLE_ID,
      queries: [
        Query.greaterThanEqual('latitude', lat - latDelta),
        Query.lessThanEqual('latitude', lat + latDelta),
        Query.greaterThanEqual('longitude', lng - lngDelta),
        Query.lessThanEqual('longitude', lng + lngDelta),
        Query.limit(40),
      ],
    });
    const rows = response.rows ?? response.documents ?? [];
    return rows
      .map((row) => {
        const d = haversineM(lat, lng, Number(row.latitude), Number(row.longitude));
        return { row, distanceM: d };
      })
      .filter((x) => Number.isFinite(x.distanceM) && x.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  } catch (err) {
    console.warn('Nearby pin query failed; creating new row', err);
    return [];
  }
}

function pinTimeMs(row) {
  const iso = row.lastConfirmedAt || row.createdAt;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * True if we should NOT merge into this existing pin.
 * Same-session short window = adjacent holes during one pass.
 */
function isMergeExempt(existing, { sessionId, skipSpatialMerge }) {
  if (skipSpatialMerge) return true;
  if (!existing) return true;
  if (sessionId && existing.sessionId === sessionId) {
    const age = Date.now() - pinTimeMs(existing);
    if (age >= 0 && age <= SAME_SESSION_WINDOW_MS) return true;
  }
  return false;
}

function isClearlyBetter(incoming, existing) {
  const newConf = Number(incoming.confidence) || 0;
  const oldConf = Number(existing.confidence) || 0;
  const newVer = Boolean(incoming.physicallyVerified);
  const oldVer = Boolean(existing.physicallyVerified);

  if (newVer && !oldVer) return true;
  // Require a clear confidence lift so soft-confirms don't overwrite close shots
  if (newConf >= oldConf + 0.08) return true;
  if (newConf > oldConf && Number(incoming.severity) > Number(existing.severity)) {
    return true;
  }
  return false;
}

async function uploadImage(blob) {
  const file = new File([blob], `pothole-${Date.now()}.jpg`, {
    type: 'image/jpeg',
  });
  return storage.createFile({
    bucketId: BUCKET_ID,
    fileId: ID.unique(),
    file,
  });
}

/**
 * Create a new pin or re-confirm a nearby existing one.
 * @returns {{ row, imageId, action: 'created'|'confirmed' }}
 */
export async function logDetection({
  blob,
  latitude,
  longitude,
  severity,
  confidence,
  sessionId,
  createdAt,
  physicallyVerified = false,
  modelVersion = 'v2',
  skipSpatialMerge = false,
}) {
  await ensureSession();
  const nowIso = createdAt || new Date().toISOString();

  const nearby = skipSpatialMerge
    ? []
    : await findNearbyPins(latitude, longitude, MERGE_RADIUS_M);

  const mergeTarget = nearby.find(
    ({ row }) => !isMergeExempt(row, { sessionId, skipSpatialMerge })
  );

  if (mergeTarget) {
    const existing = mergeTarget.row;
    const prevCount = Number(existing.confirmCount);
    const nextCount = (Number.isFinite(prevCount) ? prevCount : 1) + 1;
    const patch = {};

    if (supportsConfirmCount) patch.confirmCount = nextCount;
    if (supportsLastConfirmedAt) patch.lastConfirmedAt = nowIso;

    let imageId = existing.imageId;
    if (isClearlyBetter({ confidence, severity, physicallyVerified }, existing)) {
      const fileUpload = await uploadImage(blob);
      imageId = fileUpload.$id;
      patch.imageId = imageId;
      patch.severity = severity;
      patch.confidence = confidence;
      if (supportsPhysicallyVerified) {
        patch.physicallyVerified = Boolean(physicallyVerified);
      }
      if (supportsModelVersion && modelVersion) {
        patch.modelVersion = String(modelVersion);
      }
    }

    if (Object.keys(patch).length === 0) {
      // Columns not provisioned yet — treat as confirmed without write
      return { row: existing, imageId, action: 'confirmed' };
    }

    const row = await updateRowWithFallback(existing.$id, patch);
    return { row, imageId, action: 'confirmed' };
  }

  const fileUpload = await uploadImage(blob);
  const row = await createRowWithFallback({
    latitude,
    longitude,
    severity,
    confidence,
    imageId: fileUpload.$id,
    sessionId,
    createdAt: nowIso,
    physicallyVerified,
    modelVersion,
    confirmCount: 1,
    lastConfirmedAt: nowIso,
  });
  return { row, imageId: fileUpload.$id, action: 'created' };
}

export async function updateSeverity(rowId, severity) {
  await ensureSession();
  return tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    rowId,
    data: { severity: Number(severity) },
  });
}

export async function listDetections(limit = 500) {
  await ensureSession();
  const response = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    queries: [Query.limit(limit), Query.orderDesc('createdAt')],
  });
  return response.rows ?? response.documents ?? [];
}

export async function listDetectionsBySession(sessionId, limit = 200) {
  await ensureSession();
  const response = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    queries: [
      Query.equal('sessionId', sessionId),
      Query.limit(limit),
      Query.orderDesc('createdAt'),
    ],
  });
  return response.rows ?? response.documents ?? [];
}

export function getImageUrl(imageId) {
  return storage.getFileView({
    bucketId: BUCKET_ID,
    fileId: imageId,
  });
}

export { MERGE_RADIUS_M, SAME_SESSION_WINDOW_MS };
