/**
 * Leaflet map of all logged pothole detections.
 */

import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { ensureSession, listDetections, getImageUrl } from './appwrite.js';
import { severityColor } from './severity.js';

// Fix default marker icon paths under Vite
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

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function severityIcon(severity) {
  const color = severityColor(severity);
  return L.divIcon({
    className: 'pp-marker',
    html: `<span style="background:${color}"></span>`,
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

async function boot() {
  setStatus('Connecting…');

  const map = L.map(mapEl, { zoomControl: true }).setView([39.8283, -98.5795], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  try {
    await ensureSession();
    setStatus('Loading detections…');
    const rows = await listDetections(500);
    countEl.textContent = String(rows.length);

    if (!rows.length) {
      setStatus('No logged potholes yet — start a drive from Detect', 'warn');
      return;
    }

    const bounds = [];
    for (const row of rows) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const severity = Math.round(Number(row.severity)) || 3;
      const conf = Number(row.confidence);
      const imageUrl = row.imageId ? getImageUrl(row.imageId) : null;

      const marker = L.marker([lat, lng], { icon: severityIcon(severity) }).addTo(map);
      marker.bindPopup(
        `<div class="pp-popup">
          <strong>Severity ${severity}/5</strong>
          <p>Confidence ${(conf * 100).toFixed(0)}%</p>
          <p>${formatTime(row.createdAt)}</p>
          ${imageUrl ? `<img src="${imageUrl}" alt="Pothole" loading="lazy" />` : ''}
        </div>`,
        { maxWidth: 260 }
      );
      bounds.push([lat, lng]);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
    setStatus(`${bounds.length} potholes on map`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load: ${err.message || err}`, 'err');
  }
}

boot();
