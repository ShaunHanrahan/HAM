// HAM — zero-dependency Node server.
// Proxies the n2yo API (adds your key, handles CORS, caches) and serves the page.
// No npm install needed — uses only Node built-ins. Requires Node 18+.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ensureVendor } from "./vendor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- load .env (simple parser, no dependency) -------------------------------
function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      let v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}
loadEnv();

const PORT = process.env.PORT || 10489;
const API_KEY = process.env.N2YO_API_KEY;
// Satellite data comes from n2yo.com by default. Set N2YO_BASE to use any
// n2yo-compatible server instead (e.g. a self-hosted SatTrackAPI instance);
// no API key is needed then, and n2yo's rate limits stop applying.
const N2YO_BASE = process.env.N2YO_BASE || "https://api.n2yo.com/rest/v1/satellite";
const usingN2yo = !process.env.N2YO_BASE;
const API_LABEL = usingN2yo ? "n2yo" : "satellite API";
const hasKey = API_KEY && API_KEY !== "PASTE_YOUR_KEY_HERE";

if (usingN2yo && !hasKey) {
  console.warn(
    "\n  ⚠  No N2YO_API_KEY set. Copy .env.example to .env and add your key.\n" +
      "     Get a free key at https://www.n2yo.com/api/\n"
  );
}

// --- tiny in-memory cache to respect n2yo rate limits -----------------------
const cache = new Map(); // key -> { expires, data }
const CACHE_MAX = 500;   // bound memory: distinct request URLs can't grow the cache without limit
async function cachedFetchJSON(url, cacheKey, ttlMs, label, fetchOpts) {
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;
  // 10s cap so a hung upstream can't hang the request with it
  let res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(10_000) });
  if (res.status === 429 || res.status === 503) {
    // Throttled (Wikimedia especially — one wiki click fans out to several
    // calls, and bursts trip their limiter). Honor Retry-After up to 2s,
    // then retry once instead of failing the whole lookup.
    const after = Math.min(2000, (parseInt(res.headers.get("retry-after"), 10) || 1) * 1000);
    await new Promise(r => setTimeout(r, after));
    res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(10_000) });
  }
  if (!res.ok) throw new Error(`${label} responded ${res.status}`);
  const data = await res.json();
  cache.set(cacheKey, { data, expires: Date.now() + ttlMs });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // evict oldest (insertion order)
  return data;
}

function n2yo(pathPart, cacheKey, ttlMs) {
  // Only n2yo itself wants the key; a self-hosted backend gets a clean URL.
  const key = usingN2yo ? `&apiKey=${API_KEY}` : "";
  return cachedFetchJSON(`${N2YO_BASE}/${pathPart}${key}`, cacheKey, ttlMs, API_LABEL);
}

// --- transmitter frequencies (merged from several sources, all keyless) ------
// Each source is normalized to the shape the frontend renders:
//   { description, downlink_low, uplink_low, beacon_low?, mode, alive, source }
// and merged in /api/frequencies.

const SATNOGS_BASE = "https://db.satnogs.org/api";

// Normalize a name for fuzzy-but-safe matching (lowercase, strip non-alnum).
const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Resolve a NORAD id (and optional name) to a SatNOGS sat_id. Filtering
// transmitters by sat_id is more complete than by norad_cat_id (the ISS returns
// far more) and, via the name fallback, reaches satellites SatNOGS stores with a
// null/different norad_cat_id. Returns null when SatNOGS has no matching record.
async function satnogsSatId(noradId, name, cacheKey, ttlMs) {
  const byId = await cachedFetchJSON(
    `${SATNOGS_BASE}/satellites/?format=json&norad_cat_id=${noradId}`,
    cacheKey + ":sid", ttlMs, "SatNOGS satellites");
  const idList = Array.isArray(byId) ? byId : [];
  const idHit = idList.find(s => Number(s.norad_cat_id) === Number(noradId)) || idList[0];
  if (idHit && idHit.sat_id) return idHit.sat_id;
  // Name fallback — bridges entries SatNOGS stores without the NORAD id.
  if (name) {
    const byName = await cachedFetchJSON(
      `${SATNOGS_BASE}/satellites/?format=json&search=${encodeURIComponent(name)}`,
      cacheKey + ":sname", ttlMs, "SatNOGS search");
    const want = normName(name);
    const hit = (Array.isArray(byName) ? byName : []).find(s => {
      const n = normName(s.name);                 // close match only — guards against
      return n && want && (n === want || n.includes(want) || want.includes(n)); // grabbing an unrelated sat
    });
    if (hit && hit.sat_id) return hit.sat_id;
  }
  return null;
}

async function satnogsTransmitters(noradId, name, cacheKey, ttlMs) {
  const satId = await satnogsSatId(noradId, name, cacheKey, ttlMs);
  // Prefer the sat_id query (more complete); fall back to the legacy NORAD filter
  // so we never return less than before if resolution fails.
  const url = satId
    ? `${SATNOGS_BASE}/transmitters/?format=json&sat_id=${encodeURIComponent(satId)}`
    : `${SATNOGS_BASE}/transmitters/?format=json&satellite__norad_cat_id=${noradId}`;
  const data = await cachedFetchJSON(url, cacheKey + ":tx", ttlMs, "SatNOGS");
  const list = Array.isArray(data) ? data : (data && data.results) || [];
  return list.map(t => ({
    description: t.description, downlink_low: t.downlink_low, uplink_low: t.uplink_low,
    mode: t.mode, alive: t.alive === true, norad_cat_id: noradId, source: "satnogs"
  }));
}

// JE9PEL amateur-satellite frequency list (Mineo Wakita) — a second source,
// NORAD-keyed, that often covers ham birds SatNOGS lacks. Fetched once, parsed
// into a Map<norad, rows[]>, and cached for the request TTL. The cache holds the
// in-flight promise (not the value) so concurrent requests at TTL expiry share one
// download instead of each re-fetching the whole CSV.
const JE9PEL_URL = "https://www.ne.jp/asahi/hamradio/je9pel/satslist.csv";
let je9pelPromise = null, je9pelAt = 0;
function je9pelHz(cell) {                          // "435.310" / "436.270/10473.350" / "" -> Hz
  if (!cell) return null;
  const mhz = parseFloat(String(cell).split("/")[0].trim());
  return Number.isFinite(mhz) ? Math.round(mhz * 1e6) : null;
}
async function je9pelFetchMap() {
  const res = await fetch(JE9PEL_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(";");                 // Name;NORAD;Uplink;Downlink;Beacon;Mode;Callsign;Status
    if (c.length < 8) continue;
    const norad = parseInt(c[1], 10);
    if (!Number.isInteger(norad)) continue;    // skips the header row too
    if (!map.has(norad)) map.set(norad, []);
    map.get(norad).push({
      description: c[0].trim() || "Transmitter",
      uplink_low: je9pelHz(c[2]), downlink_low: je9pelHz(c[3]), beacon_low: je9pelHz(c[4]),
      mode: c[5].trim() || null, alive: /active/i.test(c[7]), norad_cat_id: norad, source: "je9pel"
    });
  }
  return map;
}
async function je9pelTransmitters(noradId, ttlMs) {
  try {
    if (!je9pelPromise || Date.now() - je9pelAt > ttlMs) {
      je9pelAt = Date.now();
      je9pelPromise = je9pelFetchMap().catch(e => {
        je9pelPromise = null;                       // failed download isn't cached — retry next request
        throw e;
      });
    }
    const map = await je9pelPromise;
    return (map.get(Number(noradId)) || []).filter(t => t.downlink_low || t.uplink_low || t.beacon_low);
  } catch (_) {
    return [];                                      // source down → contribute nothing
  }
}

// Merge: keep every SatNOGS row (the richest), then append rows from the other
// sources only when their downlink isn't already represented (de-dupe across
// sources, never within SatNOGS — many transmitters legitimately share a freq).
function mergeFreqs(primary, ...extra) {
  const out = primary.slice();
  const seen = new Set(primary.filter(t => t.downlink_low != null).map(t => Math.round(t.downlink_low / 1000)));
  for (const list of extra) for (const t of list) {
    const dk = t.downlink_low != null ? Math.round(t.downlink_low / 1000) : null;
    if (dk != null && seen.has(dk)) continue;
    if (dk != null) seen.add(dk);
    out.push(t);
  }
  return out;
}

// Satellite pictures + summaries come from Wikipedia via the Wikimedia REST API
// (no key needed). Wikimedia asks API clients for a User-Agent with a contact
// URL — compliant clients get a friendlier rate-limit class.
const WIKI_UA = { "User-Agent": "HAM/1.0 (+https://github.com/ShaunHanrahan/HAM)", "Accept": "application/json" };

// Full-text search returns the closest *text* match, which is often not a
// spacecraft (a viscount, a railcar…). Only accept a result whose Wikidata
// `description` actually identifies a space object — testing the description
// (not the title/excerpt) keeps precision high.
const SAT_RE = /\b(satellites?|spacecraft|space ?stations?|space telescopes?|space observator(?:y|ies)|space probes?|orbiters?|cube ?sats?|nano-?satellites?|small-?sats?|carrier rockets?|launch vehicles?|rocket (?:stage|family|body)|space capsules?|crewed spacecraft)\b/i;

// "NOAA 19" and "NOAA-19" are the same bird: compare titles with case and
// punctuation stripped so exact matches survive catalog formatting.
const normTitle = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Ordered candidates from one search: exact title matches first (trustworthy
// even when the article has no Wikidata description — the description gate
// used to throw these away), then anything the description marks as a space
// object.
async function wikiSearchSat(query, cacheKey, ttlMs) {
  const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=6`;
  const search = await cachedFetchJSON(url, cacheKey, ttlMs, "Wikipedia search", { headers: WIKI_UA });
  const pages = (search && search.pages) || [];
  const want = normTitle(query);
  const exact = pages.filter(p => want && normTitle(p.title) === want);
  const described = pages.filter(p => SAT_RE.test(p.description || ""));
  return [...new Set([...exact, ...described])];
}

// Exact lookup: NORAD catalogue number -> English Wikipedia article title, via
// Wikidata's "SATCAT number" property (P377). An exact match (no fuzzy text), so
// far more reliable than the name search for satellites that have a Wikidata
// entry (ISS, Hubble, NOAA/GOES, amateur birds…). Returns null when none exists
// (most Starlink/CubeSats) so the caller falls back to the name search.
// Swallows errors internally so a Wikidata outage just degrades to that path.
async function wikidataTitleByNorad(noradId, cacheKey, ttlMs) {
  try {
    const q = encodeURIComponent(`haswbstatement:P377=${noradId}`);
    const sUrl = `https://www.wikidata.org/w/api.php?action=query&format=json&list=search&srsearch=${q}&srlimit=1`;
    const s = await cachedFetchJSON(sUrl, cacheKey + ":wd", ttlMs, "Wikidata search", { headers: WIKI_UA });
    const qid = s?.query?.search?.[0]?.title;
    if (!qid || !/^Q\d+$/.test(qid)) return null;           // validate the QID shape
    const eUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${qid}&props=sitelinks&sitefilter=enwiki`;
    const e = await cachedFetchJSON(eUrl, cacheKey + ":wde", ttlMs, "Wikidata entity", { headers: WIKI_UA });
    return e?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
  } catch (_) {
    return null;
  }
}

async function wikiInfo(name, noradId, cacheKey, ttlMs) {
  // Resolution steps cache for at most an hour so a transient miss (throttle,
  // article created yesterday, odd search ranking) isn't frozen for a day;
  // summaries of *found* pages keep the full TTL — they barely change.
  const lookupTtl = Math.min(ttlMs, 3_600_000);

  // ID-first: an exact Wikidata SATCAT (P377) match, when the satellite has one.
  const titles = [];
  const idTitle = noradId ? await wikidataTitleByNorad(noradId, cacheKey, lookupTtl) : null;
  if (idTitle) titles.push(idTitle);
  if (!titles.length) {
    // Fallback — name search. Try the full name first (catches per-satellite
    // pages like NOAA-19); if nothing usable, retry with a simplified name
    // (drop parentheticals + the trailing catalogue number, e.g.
    // STARLINK-1234 -> STARLINK) to catch the constellation/program page.
    titles.push(...(await wikiSearchSat(name, cacheKey + ":s1", lookupTtl)).map(p => p.key || p.title));
    if (!titles.length) {
      const simple = name.replace(/\(.*?\)/g, " ").split(/[\s-]*\d/)[0].replace(/[\s\-_/]+$/, "").trim();
      if (simple.length >= 2 && simple.toLowerCase() !== name.toLowerCase())
        titles.push(...(await wikiSearchSat(simple, cacheKey + ":s2", lookupTtl)).map(p => p.key || p.title));
    }
  }
  // Walk the candidates instead of betting everything on the first: a title
  // whose summary is a disambiguation page, has no extract, or 404s just means
  // we try the next one. Per-title cache key — one key can't serve them all.
  for (const title of [...new Set(titles)].slice(0, 3)) {
    try {
      const sum = await cachedFetchJSON(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        cacheKey + ":p:" + title, ttlMs, "Wikipedia summary", { headers: WIKI_UA });
      if (sum && sum.type !== "disambiguation" && sum.extract) return sum;
    } catch (_) { /* next candidate */ }
  }
  return null;
}

// --- routing ----------------------------------------------------------------
// Each route: [regex, ttlMs, builder(matchGroups) -> n2yo path part].
// Params are constrained to numbers so nothing can be smuggled into the
// upstream n2yo URL (NUM = signed decimal for coords/alt, INT = id/radius/cat).
const NUM = "(-?\\d+(?:\\.\\d+)?)";
const INT = "(\\d+)";
const API_ROUTES = [
  {
    re: new RegExp(`^/api/above/${NUM}/${NUM}/${NUM}/${INT}/${INT}/?$`),
    ttl: 120_000, // 2 min — /above is limited to 100 calls/hour, so cache hard
    build: ([lat, lng, alt, radius, cat]) =>
      `above/${lat}/${lng}/${alt}/${radius}/${cat}/`
  },
  {
    re: new RegExp(`^/api/tle/${INT}/?$`),
    ttl: 3_600_000,
    build: ([id]) => `tle/${id}`
  }
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split("?")[0]); }
  catch (e) { res.writeHead(400); return res.end("Bad request"); }  // malformed %-encoding
  if (rel === "/") rel = "/index.html";
  const publicDir = path.join(__dirname, "public");
  const filePath = path.join(publicDir, path.normalize(rel));
  // Confine to publicDir: require an exact match or a path beneath it (trailing
  // separator stops a sibling like `public-x` from slipping past startsWith).
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath.startsWith("/api/")) {
    // Frequencies route (no n2yo key required) — handle first. Optional name
    // segment enables the SatNOGS name fallback for null-NORAD entries.
    const freqMatch = urlPath.match(/^\/api\/frequencies\/(\d+)(?:\/([^/]+))?\/?$/);
    if (freqMatch) {
      const id = freqMatch[1];
      const name = freqMatch[2] ? decodeURIComponent(freqMatch[2]) : null;
      try {
        // Merge SatNOGS (richest) + JE9PEL + built-in. Each source degrades to []
        // on failure so one being down never blanks the panel.
        const [sat, je9] = await Promise.all([
          satnogsTransmitters(id, name, urlPath, 86_400_000).catch(() => []),  // 24h
          je9pelTransmitters(id, 86_400_000)
        ]);
        return sendJSON(res, 200, mergeFreqs(sat, je9));
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // Wikipedia info route also needs no n2yo key — handle before the key check.
    // Optional leading numeric NORAD id (constrained to \d+ so nothing else can
    // be smuggled upstream), then the satellite name; name-only URLs still match.
    const wikiMatch = urlPath.match(/^\/api\/wiki\/(?:(\d+)\/)?(.+)$/);
    if (wikiMatch) {
      try {
        const noradId = wikiMatch[1] || null;
        const sum = await wikiInfo(decodeURIComponent(wikiMatch[2]), noradId, urlPath, 86_400_000); // 24h
        if (!sum || sum.type === "disambiguation" || !sum.extract) {
          return sendJSON(res, 404, { error: "No information available." });
        }
        return sendJSON(res, 200, {
          title: sum.title,
          extract: sum.extract,
          thumbnail: sum.thumbnail?.source || sum.originalimage?.source || null,
          url: sum.content_urls?.desktop?.page || null
        });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    if (usingN2yo && !hasKey) {
      return sendJSON(res, 503, {
        error: "Server has no N2YO_API_KEY configured. See README."
      });
    }
    for (const route of API_ROUTES) {
      const m = urlPath.match(route.re);
      if (m) {
        try {
          const data = await n2yo(route.build(m.slice(1)), urlPath, route.ttl);
          return sendJSON(res, 200, data);
        } catch (e) {
          return sendJSON(res, 502, { error: e.message });
        }
      }
    }
    return sendJSON(res, 404, { error: "Unknown API route" });
  }

  serveStatic(req, res);
});

await ensureVendor();

server.listen(PORT, () => {
  console.log(`\n  🛰  HAM running at  http://localhost:${PORT}\n`);
});

// Exit promptly on SIGTERM/SIGINT. As PID 1 in a container, Node gets no default
// signal handlers, so without this `docker stop` waits its full timeout then SIGKILLs.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();  // don't let a stuck socket block exit
});
