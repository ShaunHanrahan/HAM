import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- vendor third-party assets locally --------------------------------------
// Downloaded once on first start (needs internet — same as n2yo), then served
// from /vendor so the page has no runtime dependency on any CDN.
// Imported by server.js (every startup) and by docker/prefetch-vendor.mjs
// (Docker build step), so the CDN list and download logic live in one place.
export const VENDOR = [
  { file: "three.min.js",          url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" },
  { file: "satellite.min.js",      url: "https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js" },
  { file: "earth-blue-marble.jpg", url: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg" },
  { file: "earth-topology.png",    url: "https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png" },
  { file: "night-sky.png",         url: "https://cdn.jsdelivr.net/npm/three-globe/example/img/night-sky.png" }
];

export async function ensureVendor() {
  const dir = path.join(__dirname, "public", "vendor");
  fs.mkdirSync(dir, { recursive: true });
  let missing = VENDOR.filter(v => {
    const p = path.join(dir, v.file);
    return !fs.existsSync(p) || fs.statSync(p).size < 1000;
  });
  if (!missing.length) return;
  console.log(`  ↓ vendoring ${missing.length} asset(s) locally (first run)…`);
  for (const v of missing) {
    try {
      const res = await fetch(v.url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      fs.writeFileSync(path.join(dir, v.file), Buffer.from(await res.arrayBuffer()));
      console.log(`    ✓ ${v.file}`);
    } catch (e) {
      console.warn(`    ⚠ couldn't fetch ${v.file}: ${e.message}`);
    }
  }
}
