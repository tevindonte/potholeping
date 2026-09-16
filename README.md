# PotholePing

Live pothole detection in the browser: camera → ONNX YOLOv8n → Appwrite log → Leaflet map.

## Setup

```bash
npm install
npm run dev
```

Open the local URL on your phone (same network) over HTTPS or `localhost`. Camera and GPS require a secure context.

## Build / Render

```bash
npm run build
```

Deploy the `dist/` folder as a static site on Render. Set the same `VITE_*` env vars in the Render dashboard before building (Vite inlines them at build time).

## Env

See `.env` for Appwrite endpoint, project, database, table, and bucket IDs.
