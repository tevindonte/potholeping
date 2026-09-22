/**
 * NYC DOT traffic cameras (ArcGIS FeatureServer) — nearest-camera attach.
 *
 * Use this ArcGIS endpoint (NYC Open Data SODA 404'd for us).
 * Camera `url` looks like a 511ny webpage but returns JPEG bytes directly
 * (FF D8 FF…) — fetch the URL as given; do not scrape for a "real" image URL.
 */

const CAMERAS_QUERY_URL =
  'https://services6.arcgis.com/ic35UUORHLupAbxq/ArcGIS/rest/services/TrafficCameras_NYC/FeatureServer/0/query' +
  '?where=1=1&outFields=*&outSR=4326&f=json&resultRecordCount=1000';

const CACHE_KEY = 'potholeping_nyc_cameras_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NEARBY_CAMERA_MAX_M = 200;

/** @type {{ cameras: Array<{ id: number, name: string, url: string, latitude: number, longitude: number }>, fetchedAt: number } | null} */
let memoryCache = null;
let inflight = null;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function readDiskCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.cameras?.length || !parsed.fetchedAt) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode — memory cache still works */
  }
}

function normalizeFeature(feature) {
  const a = feature?.attributes || {};
  const g = feature?.geometry || {};
  const longitude = Number(g.x);
  const latitude = Number(g.y);
  const url = typeof a.url === 'string' ? a.url.trim() : '';
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !url) {
    return null;
  }
  return {
    id: Number(a.OBJECTID),
    name: String(a.name || `Camera ${a.OBJECTID}`),
    url,
    latitude,
    longitude,
  };
}

async function fetchCameraListFromNetwork() {
  const res = await fetch(CAMERAS_QUERY_URL);
  if (!res.ok) {
    throw new Error(`NYC camera list HTTP ${res.status}`);
  }
  const json = await res.json();
  const features = json.features || [];
  const cameras = [];
  for (const f of features) {
    const cam = normalizeFeature(f);
    if (cam) cameras.push(cam);
  }
  if (!cameras.length) {
    throw new Error('NYC camera list empty');
  }
  const payload = { cameras, fetchedAt: Date.now() };
  memoryCache = payload;
  writeDiskCache(payload);
  return cameras;
}

/**
 * Cached camera list (~215 static points). Refresh daily or when cold.
 */
export async function getNycCameras() {
  if (memoryCache?.cameras?.length) {
    if (Date.now() - memoryCache.fetchedAt <= CACHE_TTL_MS) {
      return memoryCache.cameras;
    }
  }
  const disk = readDiskCache();
  if (disk?.cameras?.length) {
    memoryCache = disk;
    return disk.cameras;
  }
  if (!inflight) {
    inflight = fetchCameraListFromNetwork().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Warm cache on app start (non-blocking). */
export function prefetchNycCameras() {
  getNycCameras().catch((err) => {
    console.warn('NYC camera prefetch failed', err);
  });
}

/**
 * @returns {{ id: number, name: string, url: string, latitude: number, longitude: number, distance_meters: number } | null}
 */
export function findNearestCamera(reportLat, reportLng, cameras, maxMeters = NEARBY_CAMERA_MAX_M) {
  let nearest = null;
  let minDist = Infinity;
  for (const cam of cameras) {
    const dist = haversineMeters(reportLat, reportLng, cam.latitude, cam.longitude);
    if (dist < minDist) {
      minDist = dist;
      nearest = cam;
    }
  }
  if (!nearest || minDist > maxMeters) return null;
  return { ...nearest, distance_meters: minDist };
}

/**
 * Fetch current camera frame. URL is used as-is (JPEG response despite webpage-looking path).
 * @returns {Promise<Blob|null>}
 */
export async function fetchCameraFrameBlob(cameraUrl) {
  if (!cameraUrl) return null;
  const res = await fetch(cameraUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Camera frame HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // JPEG SOI — confirmed working for 511ny CCTV URLs
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Camera frame was not JPEG');
  }
  const type = res.headers.get('content-type') || 'image/jpeg';
  return new Blob([buf], { type: type.includes('jpeg') ? type : 'image/jpeg' });
}

/**
 * Resolve nearest ≤200m camera + fresh JPEG blob, or null if none / failure.
 */
export async function resolveNearbyCameraAttachment(latitude, longitude) {
  const cameras = await getNycCameras();
  const nearest = findNearestCamera(
    Number(latitude),
    Number(longitude),
    cameras,
    NEARBY_CAMERA_MAX_M
  );
  if (!nearest) return null;

  const blob = await fetchCameraFrameBlob(nearest.url);
  if (!blob) return null;

  return {
    camera_id: nearest.id,
    name: nearest.name,
    distance_meters: Math.round(nearest.distance_meters * 10) / 10,
    blob,
    fetched_at: new Date().toISOString(),
  };
}
