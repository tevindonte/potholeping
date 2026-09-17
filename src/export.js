/**
 * Client-side CSV / GeoJSON export helpers.
 */

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function rowsToCsv(rows) {
  const header = [
    'id',
    'latitude',
    'longitude',
    'severity',
    'confidence',
    'sessionId',
    'createdAt',
    'physicallyVerified',
    'modelVersion',
    'imageId',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.$id ?? r.id ?? '',
        r.latitude,
        r.longitude,
        r.severity,
        r.confidence,
        r.sessionId,
        r.createdAt,
        r.physicallyVerified ?? false,
        r.modelVersion ?? '',
        r.imageId ?? '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function rowsToGeoJson(rows) {
  return {
    type: 'FeatureCollection',
    features: rows
      .map((r) => {
        const lat = Number(r.latitude);
        const lng = Number(r.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            id: r.$id ?? r.id ?? null,
            severity: Number(r.severity),
            confidence: Number(r.confidence),
            sessionId: r.sessionId,
            createdAt: r.createdAt,
            physicallyVerified: Boolean(r.physicallyVerified),
            modelVersion: r.modelVersion ?? null,
            imageId: r.imageId ?? null,
          },
        };
      })
      .filter(Boolean),
  };
}

export function exportCsv(rows, filename = `potholeping-${Date.now()}.csv`) {
  downloadBlob(
    filename,
    new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' })
  );
}

export function exportGeoJson(rows, filename = `potholeping-${Date.now()}.geojson`) {
  downloadBlob(
    filename,
    new Blob([JSON.stringify(rowsToGeoJson(rows), null, 2)], {
      type: 'application/geo+json;charset=utf-8',
    })
  );
}
