/**
 * Offline detection queue backed by IndexedDB (idb).
 */

import { openDB } from 'idb';

const DB_NAME = 'potholeping';
const STORE = 'pending';
const DB_VERSION = 1;

let dbPromise = null;
const listeners = new Set();

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      },
    });
  }
  return dbPromise;
}

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function emitQueueChange() {
  const count = await pendingCount();
  for (const fn of listeners) {
    try {
      fn(count);
    } catch {
      /* ignore */
    }
  }
}

export async function enqueueDetection(entry) {
  const db = await getDb();
  const id = await db.add(STORE, {
    ...entry,
    queuedAt: Date.now(),
  });
  await emitQueueChange();
  return id;
}

export async function listPending() {
  const db = await getDb();
  return db.getAll(STORE);
}

export async function removePending(id) {
  const db = await getDb();
  await db.delete(STORE, id);
  await emitQueueChange();
}

export async function pendingCount() {
  const db = await getDb();
  return db.count(STORE);
}

/**
 * Retry all queued uploads. `uploader` receives a pending record and
 * should throw on failure so the entry stays queued.
 */
export async function flushQueue(uploader) {
  const pending = await listPending();
  let flushed = 0;
  for (const item of pending) {
    try {
      await uploader(item);
      await removePending(item.id);
      flushed += 1;
    } catch (err) {
      console.warn('Queue flush failed for', item.id, err);
      // Keep remaining items; stop hammering if clearly offline
      if (!navigator.onLine) break;
    }
  }
  await emitQueueChange();
  return flushed;
}
