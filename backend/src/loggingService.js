// backend/src/loggingService.js
// NDJSON telemetry logger with per-family files, daily rotation, per-device rate limiting,
// and a small write queue. Family-specific whitelists supported via:
//   backend/config/logPoints.<family>.json
// Falls back to backend/config/logPoints.json if family file missing.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------- path & env ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LOG_DIR = (process.env.LOG_DIR?.trim && process.env.LOG_DIR.trim())
  || path.join(__dirname, "..", "data", "logs");

const SITE_ID_DEFAULT = process.env.SITE_ID || "site";
const LOG_POINTS_DEFAULT_PATH = path.join(__dirname, "..", "config", "logPoints.json");

// Minimum interval (ms) between logs per (family,site,tank). Default = 5 minutes.
const LOG_MIN_INTERVAL_MS = Number(process.env.LOG_MIN_INTERVAL_MS || 300_000);

// ---------- internal state ----------
/** Map<key, fs.WriteStream> where key = `${family}:${site}:${dateStr}` */
const streams = new Map();
/** Global write queue of { stream, line } to handle backpressure smoothly */
const queue = [];
let writing = false;

/** Cache of family -> Set<string> whitelist */
const whitelistCache = new Map();
/** Last write time per (family:site:tank) for rate limiting */
const lastWrite = new Map();

// ---------- helpers ----------
function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function todayStrUTC(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function familyFromDeviceId(deviceId = "") {
  // Expect "<family>-<rest>", e.g., "ctrl-C01", "bmm-C01", "util-CO2_A"
  const idx = deviceId.indexOf("-");
  return (idx > 0 ? deviceId.slice(0, idx) : "ctrl").toLowerCase();
}

function whitelistPathForFamily(family) {
  const alt = path.join(__dirname, "..", "config", `logPoints.${family}.json`);
  return fs.existsSync(alt) ? alt : LOG_POINTS_DEFAULT_PATH;
}

function loadWhitelistForFamily(family) {
  if (whitelistCache.has(family)) return whitelistCache.get(family);
  try {
    const p = whitelistPathForFamily(family);
    const raw = fs.readFileSync(p, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg || !Array.isArray(cfg.log_points)) throw new Error("missing 'log_points' array");
    const set = new Set(cfg.log_points);
    whitelistCache.set(family, set);
    return set;
  } catch (e) {
    console.error(`Failed to load whitelist for family "${family}":`, e.message);
    const empty = new Set();
    whitelistCache.set(family, empty);
    return empty;
  }
}

function truncateValue(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  if (key === "counter_value" || key === "timer_seconds") return Math.trunc(value);
  return Math.round(value * 10) / 10; // 1 decimal place
}

function filteredSubset(sensorDict, allowSet) {
  const out = {};
  for (const [k, v] of Object.entries(sensorDict || {})) {
    if (allowSet.has(k)) out[k] = truncateValue(k, v);
  }
  return out;
}

function fileName(family, site, dateStr) {
  return `telemetry-${family}-${site}-${dateStr}.ndjson`;
}

function getStream(family, site, dateStr) {
  const key = `${family}:${site}:${dateStr}`;
  if (streams.has(key)) return streams.get(key);

  ensureDirSync(LOG_DIR);
  const fpath = path.join(LOG_DIR, fileName(family, site, dateStr));
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
/** Initialize logging directory (idempotent). */
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
 *   ts_utc, site_id, tank_id, device_id, s: {...}, qc: {status}
 * }
 */
export async function logTelemetry(payload) {
  try {
    initLogger();

    const site = (payload?.site_id || SITE_ID_DEFAULT);
    const fam  = familyFromDeviceId(payload?.device_id || "");
    const tank = payload?.tank_id || "unknown";
    const ts   = Date.now();

    // Rate limit per (family:site:tank)
    const rateKey = `${fam}:${site}:${tank}`;
    const last = lastWrite.get(rateKey) || 0;
    if (ts - last < LOG_MIN_INTERVAL_MS) return;

    const dateStr = todayStrUTC(payload?.ts_utc ? new Date(payload.ts_utc) : new Date());
    const stream  = getStream(fam, site, dateStr);

    const allowSet = loadWhitelistForFamily(fam);
    const row = {
      ts_utc: payload?.ts_utc || new Date().toISOString(),
      site_id: site,
      tank_id: tank,
      device_id: payload?.device_id,
      qc: payload?.qc?.status || "ok",
      ...filteredSubset(payload?.s || {}, allowSet)
    };

    queue.push({ stream, line: JSON.stringify(row) + "\n" });
    lastWrite.set(rateKey, ts);
    flushQueue();
  } catch (e) {
    console.error("logTelemetry error:", e.message);
  }
}

/** Flush queue and close all open streams. Call on shutdown. */
export async function shutdownLogger() {
  try {
    while (queue.length) {
      await flushQueue();
    }
    // Close all open streams
    await Promise.all(
      Array.from(streams.values()).map(
        (s) => new Promise((res) => { s.end(() => res()); })
      )
    );
    streams.clear();
  } catch (e) {
    console.error("shutdownLogger error:", e.message);
  }
}
