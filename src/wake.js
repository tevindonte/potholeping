/**
 * Screen Wake Lock — keep the display on during a detection session.
 * Silent no-op when the API is missing or the request is denied.
 */

let wakeLock = null;
let reacquireOnVisible = false;

async function requestLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (err) {
    console.warn('Wake Lock request failed:', err);
    wakeLock = null;
    return false;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible' && reacquireOnVisible) {
    requestLock();
  }
}

/** Call from Start Detecting (user gesture). */
export async function acquireWakeLock() {
  reacquireOnVisible = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  return requestLock();
}

/** Call from Stop / teardown. */
export async function releaseWakeLock() {
  reacquireOnVisible = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  try {
    if (wakeLock) await wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

export function isWakeLockActive() {
  return Boolean(wakeLock);
}
