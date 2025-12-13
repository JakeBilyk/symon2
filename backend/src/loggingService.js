// backend/src/loggingService.js
// NDJSON telemetry logger with per-tank files, daily rotation, per-device rate limiting,
// and a small write queue. Family-specific whitelists supported via:
//   backend/config/logPoints.<family>.json
// Falls back to backend/config/logPoints.json if family file missing.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------- path & env ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR =
  (process.env.LOG_DIR?.trim && process.env.LOG_DIR.trim()) ||
  path.join(__dirname, "..", "data", "logs");

// Rate limiting per (family/site/tank). Default 30s.
const MIN_INTERVAL_MS = Number(process.env.LOG_MIN_INTERVAL_MS || 30_000);

// Backpressure handling
const streams = new Map();
/** Global write queue of { stream, line } to handle backpressure smoothly */
const queue = [];
let writing = false;

/** Cache of family -> Set<string> whitelist */
const whitelistCache = new Map();

/** Map<rateKey, lastWriteMs> */
const lastWrite = new Map();

// ---------- helpers ----------
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayStrUTC(d = new Date()) {
  // YYYY-MM-DD in UTC
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function hawaiiNow(d = new Date()) {
  // Hawaiʻi Standard Time is always UTC-10 (no DST)
  const HST_OFFSET_MS = -10 * 60 * 60 * 1000;
  return new Date(d.getTime() + HST_OFFSET_MS);
}

function nowHawaiiISO(d = new Date()) {
  // ISO string with explicit -10:00 offset
  return hawaiiNow(d).toISOString().replace("Z", "-10:00");
}

function todayStrHawaii(d = new Date()) {
  // YYYY-MM-DD in Hawaiʻi time (so your daily files align with your day)
  const hst = hawaiiNow(d);
  const yyyy = hst.getUTCFullYear();
  const mm = String(hst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(hst.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Load or return cached whitelist Set for family
function loadWhitelistForFamily(family) {
  if (whitelistCache.has(family)) return whitelistCache.get(family);

  const cfgDir = path.join(__dirname, "..", "config");
  const famPath = path.join(cfgDir, `logPoints.${family}.json`);
  const defaultPath = path.join(cfgDir, "logPoints.json");

  let raw;
  try {
    if (fs.existsSync(famPath)) raw = fs.readFileSync(famPath, "utf-8");
    else raw = fs.readFileSync(defaultPath, "utf-8");
  } catch (e) {
    console.warn(
      `logger: could not read whitelist for family '${family}': ${e.message}`
    );
    const empty = new Set();
    whitelistCache.set(family, empty);
    return empty;
  }

  try {
    const json = JSON.parse(raw);
    // supports either { points:[...]} or simple array
    const points = Array.isArray(json)
  ? json
  : (json?.log_points || json?.points || []);

    const set = new Set(points);
    whitelistCache.set(family, set);
    return set;
  } catch (e) {
    console.warn(
      `logger: invalid whitelist JSON for family '${family}': ${e.message}`
    );
    const empty = new Set();
    whitelistCache.set(family, empty);
    return empty;
  }
}

function truncateValue(key, v) {
  // Keep floats tidy; leave ints/bools/strings untouched.
  if (typeof v !== "number") return v;
  if (!Number.isFinite(v)) return v;
  // reduce typical sensor noise + file size
  return Math.round(v * 10) / 10; // 1 decimal place
}

function filteredSubset(sensorDict, allowSet) {
  const out = {};
  for (const [k, v] of Object.entries(sensorDict || {})) {
    if (allowSet.has(k)) out[k] = truncateValue(k, v);
  }
  return out;
}

function fileName(family, site, tank, dateStr) {
  // Per-tank, per-day NDJSON file for fast History queries and minimal scanning
  return `telemetry-${family}-${site}-${tank}-${dateStr}.ndjson`;
}

function getStream(family, site, tank, dateStr) {
  // Include tank in key so we never mix tanks into the same file/stream
  const key = `${family}:${site}:${tank}:${dateStr}`;
  if (streams.has(key)) return streams.get(key);

  ensureDirSync(LOG_DIR);
  const fpath = path.join(LOG_DIR, fileName(family, site, tank, dateStr));
  const stream = fs.createWriteStream(fpath, { flags: "a" });
  stream.on("error", (e) => console.error("NDJSON stream error:", e.message));
  streams.set(key, stream);
  return stream;
}

async function flushQueue() {
  if (writing) return;
  writing = true;

  while (queue.length) {
    const { stream, line } = queue.shift();
    if (!stream) continue;
    if (!stream.write(line)) {
      await new Promise((r) => stream.once("drain", r));
    }
  }

  writing = false;
}

// ---------- public API ----------
/** Ensure log directory exists. Call once on server startup. */
export function initLogger() {
  ensureDirSync(LOG_DIR);
}

/** Return the directory where NDJSON telemetry logs are stored. */
export function getLogDirectory() {
  ensureDirSync(LOG_DIR);
  return LOG_DIR;
}

/**
 * Log a telemetry payload (rate-limited per family/site/tank).
 * Payload shape:
 * {
 *   ts_utc, site_id, tank_id, device_id,
 *   s: {...},            // sensor values
 *   qc: { status: ... }  // optional quality/control status
 * }
 */
export function logTelemetry(payload, familyOverride = null) {
  try {
    const fam = String(familyOverride || payload?.family || payload?.site_family || "unknown");
    const site = String(payload?.site_id ?? "unknown");
    const tank = String(payload?.tank_id ?? "unknown");

    const rateKey = `${fam}:${site}:${tank}`;
    const ts = Date.now();
    const last = lastWrite.get(rateKey) || 0;
    if (ts - last < MIN_INTERVAL_MS) return;

    const dateStr = todayStrHawaii(
      payload?.ts_utc ? new Date(payload.ts_utc) : new Date()
    );
    const stream = getStream(fam, site, tank, dateStr);

    const allowSet = loadWhitelistForFamily(fam);
    const row = {
      ts_hst: nowHawaiiISO(payload?.ts_utc ? new Date(payload.ts_utc) : new Date()),
      tank_id: tank,
      ...filteredSubset(payload?.s || {}, allowSet),
    };
    

    queue.push({ stream, line: JSON.stringify(row) + "\n" });
    lastWrite.set(rateKey, ts);
    flushQueue();
  } catch (e) {
    console.error("logTelemetry error:", e.message);
  }
}

/**
 * Close any open file streams and drain the queue.
 * Call on SIGINT/SIGTERM for clean shutdown.
 */
export async function shutdownLogger() {
  try {
    while (queue.length) {
      await flushQueue();
    }
    // Close all open streams
    await Promise.all(
      Array.from(streams.values()).map(
        (s) =>
          new Promise((res) => {
            s.end(() => res());
          })
      )
    );
    streams.clear();
  } catch (e) {
    console.error("shutdownLogger error:", e.message);
  }
}
