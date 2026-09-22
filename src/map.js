/**
 * Leaflet map: clusters, date filter, export, severity override, verified badges.
 */

import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './style.css';
import L from 'leaflet';
import 'leaflet.markercluster';
import {
  ensureSession,
  listDetections,
  getImageUrl,
  updateSeverity,
} from './appwrite.js';
import { severityColor } from './severity.js';
import { exportCsv, exportGeoJson } from './export.js';

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const mapEl = document.getElementById('map');
const statusEl = document.getElementById('mapStatus');
const countEl = document.getElementById('mapCount');
const rangeEl = document.getElementById('dateRange');
const exportCsvBtn = document.getElementById('exportCsv');
const exportGeoBtn = document.getElementById('exportGeojson');

let allRows = [];
let visibleRows = [];
let map;
let clusterGroup;

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function isVerified(row) {
  return row.physicallyVerified === true || row.physicallyVerified === 'true';
}

function severityIcon(severity, verified) {
  const color = severityColor(severity);
  const ring = verified ? 'pp-marker verified' : 'pp-marker';
  return L.divIcon({
    className: ring,
    html: `<span style="background:${color}"></span>${
      verified ? '<i class="pp-verified-dot" title="Physically verified"></i>' : ''
    }`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function rowTime(row) {
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function filterRows(rows, range) {
  if (range === 'all') return rows.slice();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return rows.filter((r) => rowTime(r) >= start.getTime());
  }
  if (range === 'week') {
    return rows.filter((r) => rowTime(r) >= now - 7 * dayMs);
  }
  if (range === 'month') {
    return rows.filter((r) => rowTime(r) >= now - 30 * dayMs);
  }
  return rows.slice();
}

function popupHtml(row) {
  const severity = Math.round(Number(row.severity)) || 3;
  const conf = Number(row.confidence);
  const verified = isVerified(row);
  const imageUrl = row.imageId ? getImageUrl(row.imageId) : null;
  const cameraImageUrl = row.cameraImageId
    ? getImageUrl(row.cameraImageId)
    : null;
  let nearbyMeta = null;
  if (row.nearbyCamera) {
    try {
      nearbyMeta =
        typeof row.nearbyCamera === 'string'
          ? JSON.parse(row.nearbyCamera)
          : row.nearbyCamera;
    } catch {
      nearbyMeta = null;
    }
  }
  const options = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<option value="${n}" ${n === severity ? 'selected' : ''}>${n}</option>`
    )
    .join('');

  return `<div class="pp-popup" data-row-id="${row.$id}">
    <strong>Severity <span class="pp-sev-label">${severity}</span>/5</strong>
    <p class="pp-verify-tag ${verified ? 'ok' : ''}">${
      verified ? 'Physically verified' : 'Visual only'
    }</p>
    ${row.modelVersion ? `<p>Model ${row.modelVersion}</p>` : ''}
    <p>Confidence ${(conf * 100).toFixed(0)}%</p>
    <p>Confirmed ${Number(row.confirmCount) > 0 ? Number(row.confirmCount) : 1}×</p>
    <p>First ${formatTime(row.createdAt)}</p>
    ${
      row.lastConfirmedAt && row.lastConfirmedAt !== row.createdAt
        ? `<p>Last seen ${formatTime(row.lastConfirmedAt)}</p>`
        : ''
    }
    <label class="pp-override">
      Correct severity
      <select class="pp-severity-select" data-row-id="${row.$id}">${options}</select>
    </label>
    <p class="pp-override-msg" hidden></p>
    ${imageUrl ? `<img src="${imageUrl}" alt="Pothole" loading="lazy" />` : ''}
    ${
      cameraImageUrl
        ? `<p class="pp-cam-label">Nearby DOT cam${
            nearbyMeta?.name ? ` · ${nearbyMeta.name}` : ''
          }${
            nearbyMeta?.distance_meters != null
              ? ` · ${Math.round(nearbyMeta.distance_meters)}m`
              : ''
          }</p><img src="${cameraImageUrl}" alt="Nearby traffic camera" loading="lazy" />`
        : ''
    }
  </div>`;
}

function bindPopupHandlers(marker, row) {
  marker.on('popupopen', () => {
    const popupEl = marker.getPopup()?.getElement();
    if (!popupEl) return;
    const select = popupEl.querySelector('.pp-severity-select');
    const msg = popupEl.querySelector('.pp-override-msg');
    const label = popupEl.querySelector('.pp-sev-label');
    if (!select || select.dataset.bound) return;
    select.dataset.bound = '1';

    select.addEventListener('change', async () => {
      const next = Number(select.value);
      select.disabled = true;
      if (msg) {
        msg.hidden = false;
        msg.textContent = 'Saving…';
        msg.dataset.kind = '';
      }
      try {
        await updateSeverity(row.$id, next);
        row.severity = next;
        if (label) label.textContent = String(next);
        marker.setIcon(severityIcon(next, isVerified(row)));
        if (msg) {
          msg.textContent = 'Updated';
          msg.dataset.kind = 'ok';
        }
      } catch (err) {
        console.error(err);
        select.value = String(Math.round(Number(row.severity)) || 3);
        if (msg) {
          msg.textContent =
            err?.code === 401 || /permission|unauthorized/i.test(err?.message || '')
              ? 'Update blocked — enable Update on the Appwrite table'
              : `Save failed: ${err.message || err}`;
          msg.dataset.kind = 'err';
        }
      } finally {
        select.disabled = false;
      }
    });
  });
}

function renderMarkers(rows) {
  clusterGroup.clearLayers();
  const bounds = [];

  for (const row of rows) {
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const severity = Math.round(Number(row.severity)) || 3;
    const verified = isVerified(row);
    const marker = L.marker([lat, lng], {
      icon: severityIcon(severity, verified),
    });
    marker.bindPopup(popupHtml(row), { maxWidth: 280 });
    bindPopupHandlers(marker, row);
    clusterGroup.addLayer(marker);
    bounds.push([lat, lng]);
  }

  countEl.textContent = String(bounds.length);
  if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    setStatus(`${bounds.length} potholes on map`, 'ok');
  } else {
    setStatus('No potholes in this date range', 'warn');
  }
}

function applyFilter() {
  visibleRows = filterRows(allRows, rangeEl.value);
  renderMarkers(visibleRows);
}

async function boot() {
  setStatus('Connecting…');

  map = L.map(mapEl, { zoomControl: true }).setView([39.8283, -98.5795], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
  });
  map.addLayer(clusterGroup);

  try {
    await ensureSession();
    setStatus('Loading detections…');
    allRows = await listDetections(500);

    if (!allRows.length) {
      countEl.textContent = '0';
      setStatus('No logged potholes yet — start a drive from Detect', 'warn');
    } else {
      applyFilter();
    }
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load: ${err.message || err}`, 'err');
  }
}

rangeEl.addEventListener('change', applyFilter);
exportCsvBtn.addEventListener('click', () => {
  if (!visibleRows.length) {
    setStatus('Nothing to export in this range', 'warn');
    return;
  }
  exportCsv(visibleRows);
  setStatus(`Exported ${visibleRows.length} rows as CSV`, 'ok');
});
exportGeoBtn.addEventListener('click', () => {
  if (!visibleRows.length) {
    setStatus('Nothing to export in this range', 'warn');
    return;
  }
  exportGeoJson(visibleRows);
  setStatus(`Exported ${visibleRows.length} features as GeoJSON`, 'ok');
});

boot();
