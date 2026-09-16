/**
 * Appwrite client: anonymous session, image upload, row create/list/update.
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

let ready = false;

/** Ensure an anonymous Appwrite session exists (idempotent). */
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

/**
 * Upload a JPEG blob and create a detection row.
 * @returns {{ row, imageId }}
 */
export async function logDetection({
  blob,
  latitude,
  longitude,
  severity,
  confidence,
  sessionId,
}) {
  await ensureSession();

  const file = new File([blob], `pothole-${Date.now()}.jpg`, {
    type: 'image/jpeg',
  });

  const fileUpload = await storage.createFile({
    bucketId: BUCKET_ID,
    fileId: ID.unique(),
    file,
  });

  const row = await tablesDB.createRow({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    rowId: ID.unique(),
    data: {
      latitude,
      longitude,
      severity,
      confidence,
      imageId: fileUpload.$id,
      sessionId,
      createdAt: new Date().toISOString(),
    },
  });

  return { row, imageId: fileUpload.$id };
}

/** Patch severity on an existing row (requires Update permission on the table). */
export async function updateSeverity(rowId, severity) {
  await ensureSession();
  return tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    rowId,
    data: { severity: Number(severity) },
  });
}

/** Fetch recent detections for the map view. */
export async function listDetections(limit = 500) {
  await ensureSession();

  const response = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    queries: [Query.limit(limit), Query.orderDesc('createdAt')],
  });

  return response.rows ?? response.documents ?? [];
}

/** Public URL for a stored detection photo. */
export function getImageUrl(imageId) {
  return storage.getFileView({
    bucketId: BUCKET_ID,
    fileId: imageId,
  });
}
