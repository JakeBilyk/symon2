import dotenv from "dotenv";

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { createMqttClient, publishTelemetry } from "./mqttPublisher.js";

import {
  processTelemetryForAlarms,
  flushAlarmBatch,
  getAlarmThresholds,
  setAlarmThresholds,
} from "./alarmService.js";
import { loadRegisterMap, getBlocks, decodePointsFromBlocks } from "./registerMap.js";
import { readBlocksForDevice } from "./modbusBlocks.js";
import { initLogger, shutdownLogger, getLogDirectory } from "./loggingService.js";

// ---- path helpers ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");
const configDir = path.join(projectRoot, "config");

// Load env from backend/.env (one level up from src/)
dotenv.config({ path: path.join(projectRoot, ".env") });

const SITE_ID = process.env.SITE_ID || "dev01";
const DEVICE_FW = "gw-1.0.0";
const POLL_MS = Number(process.env.POLL_MS || 60_000); // polling cadence
const CONCURRENCY = Number(process.env.POLL_CONCURRENCY || 8); // worker pool size
const FAMILY_RELOAD_MS = Number(process.env.FAMILY_RELOAD_MS || 5 * 60_000);
const API_PORT = Number(process.env.API_PORT || 4000);
const API_HOST = process.env.API_HOST || "0.0.0.0";

// ---- live snapshot cache for /api/live ----
// Structure: liveCache[tankId] = { family, ip, ts_utc, qc, ...decodedValues }
const liveCache = Object.create(null);

function updateLiveCache(tankId, family, ip, payload) {
  liveCache[tankId] = {
    family,
    ip,
    ts_utc: payload.ts_utc,
    qc: payload.qc?.status || "ok",
    ...payload.s,
  };
}

// Ensure util controllers always exist in /api/live, even before first poll,
// seeded from backend/config/utilityConfig.json (id -> ip)
function ensureUtilDevicesInLiveCache() {
  try {
    const utilCfgPath = path.join(configDir, "utilityConfig.json");
    if (!fs.existsSync(utilCfgPath)) return;

    const utilCfg = JSON.parse(fs.readFileSync(utilCfgPath, "utf8"));
    for (const [tankId, ip] of Object.entries(utilCfg || {})) {
      if (!liveCache[tankId]) {
        liveCache[tankId] = {
          family: "util",
          ip: typeof ip === "string" ? ip : ip?.ip,
          ts_utc: null,
          qc: "fail",
        };
      }
    }
  } catch (e) {
    console.error("ensureUtilDevicesInLiveCache error:", e.message);
  }
}

// ----  "live tanks" filter (applies to controllers) ----
function liveTanksPath() {
  return path.join(configDir, "liveTanks.json");
}

function loadLiveTanks() {
  const p = liveTanksPath(); // backend/config/liveTanks.json
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("liveTanks.json parse error:", e.message);
    return null;
  }
}

async function saveLiveTanks(map) {
  const p = liveTanksPath();
  const payload = JSON.stringify(map, null, 2) + "\n";
  await fsp.writeFile(p, payload, "utf8");
}

function listTankIds() {
  try {
    const cfgPath = path.join(configDir, "tankConfig.json");
    const raw = fs.readFileSync(cfgPath, "utf8");
    const data = JSON.parse(raw);
    return Object.keys(data || {}).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  } catch (e) {
    console.error("tankConfig.json load error:", e.message);
    return [];
  }
}

const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains; preload";
const shouldDisableHsts = process.env.DISABLE_HSTS === "1";

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  if (!shouldDisableHsts) {
    res.setHeader("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  setCorsHeaders(res);
  setSecurityHeaders(res);
  res.end(JSON.stringify(body));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readRequestBody(req, limitBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Very small parser: "ph" => { family: null, field: "ph" }
// "ctrl.ph" => { family: "ctrl", field: "ph" }, etc.
function resolveMetricSpec(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const parts = value.split(".");
  let family = null;
  let field = null;

  if (parts.length === 1) {
    field = parts[0];
  } else if (parts.length === 2) {
    family = parts[0] || null;
    field = parts[1];
  } else {
    return null;
  }

  // Back-compat for History UI: it requests metric=temp but we log temp1_C
  if (field === "temp") field = "temp1_C";

  return { family, field };
}

// Get NDJSON log files for a tank.
// telemetry-<family>-<site>-<tank>-<YYYY-MM-DD>.ndjson
function getLogFilePathsForTank(tankId) {
  const dir = getLogDirectory();
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".ndjson")) continue;
    if (!ent.name.includes(`-${tankId}-`)) continue;
    files.push(path.join(dir, ent.name));
  }

  files.sort();
  return files;
}

// ---- log file download helpers ----
function safeBasename(name) {
  const s = String(name || "");
  if (!s) return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\u0000")) return null;
  return path.basename(s);
}

function statToMeta(fullPath) {
  const st = fs.statSync(fullPath);
  return {
    name: path.basename(fullPath),
    size: st.size,
    mtime: new Date(st.mtimeMs).toISOString(),
  };
}

// Read NDJSON logs and create a time series that matches History.jsx:
// [{ ts: ISOString, value: number }, ...]
async function readLogSeries(tankId, metricSpec, startMs, endMs) {
  const files = getLogFilePathsForTank(tankId);
  if (!files.length) return [];

  const out = [];

  for (const f of files) {
    let raw = "";
    try {
      raw = await fsp.readFile(f, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;

      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }

      const t = Date.parse(row.ts_hst || row.ts_utc || row.ts || row.ts_local || row.time);
      if (!Number.isFinite(t)) continue;
      if (t < startMs || t > endMs) continue;

      if (metricSpec.family && row.family && row.family !== metricSpec.family) {
        continue;
      }

      const s = row.s || row.values || row || {};
      const v = s[metricSpec.field];

      if (typeof v !== "number" || !Number.isFinite(v)) continue;

      out.push({ ts: new Date(t).toISOString(), value: v });
    }
  }

  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out;
}

// ---- CO2 config + daily usage helpers ----
function co2ConfigPath() {
  return path.join(configDir, "co2Config.json");
}

function loadCo2Config() {
  const p = co2ConfigPath();
  if (!fs.existsSync(p)) return { defaultLpm: 2.5, perTank: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const defaultLpm = Number(parsed?.defaultLpm ?? 2.5);
    return {
      defaultLpm: Number.isFinite(defaultLpm) && defaultLpm > 0 ? defaultLpm : 2.5,
      perTank:
        parsed?.perTank && typeof parsed.perTank === "object" ? parsed.perTank : {},
    };
  } catch {
    return { defaultLpm: 2.5, perTank: {} };
  }
}

async function saveCo2Config(cfg) {
  const payload = JSON.stringify(cfg, null, 2) + "\n";
  await fsp.writeFile(co2ConfigPath(), payload, "utf8");
}

// Compute a delta over a day from a monotonic counter that may reset.
function computeCounterDelta(values) {
  let total = 0;
  let prev = null;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      prev = v;
      continue;
    }
    const d = v - prev;
    if (d >= 0) total += d;
    else total += v; // reset
    prev = v;
  }
  return total;
}

// Read NDJSON logs for a specific Hawaiʻi day and return "seconds on" as a delta of a counter-like field.
async function readDailyCounterSeconds(tankId, field, dayStartIso, dayEndIso) {
  const files = getLogFilePathsForTank(tankId);
  if (!files.length) return 0;

  const startMs = Date.parse(dayStartIso);
  const endMs = Date.parse(dayEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;

  const samples = [];

  for (const f of files) {
    let raw = "";
    try {
      raw = await fsp.readFile(f, "utf8");
    } catch {
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }

      const t = Date.parse(row.ts_hst || row.ts_utc || row.ts);
      if (!Number.isFinite(t)) continue;
      if (t < startMs || t >= endMs) continue;

      const v = row[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        samples.push({ t, v });
      }
    }
  }

  samples.sort((a, b) => a.t - b.t);
  return computeCounterDelta(samples.map((s) => s.v));
}

async function handleApiRequest(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const { pathname, searchParams } = url;

  // --- live snapshot endpoint ---
  if (req.method === "GET" && pathname === "/api/live") {
    // ensure util controllers are always present in response (even if offline)
    ensureUtilDevicesInLiveCache();

    const tankId = searchParams.get("tankId");
    if (tankId) {
      const entry = liveCache[tankId] || null;
      sendJson(res, 200, { [tankId]: entry });
      return;
    }
    sendJson(res, 200, liveCache);
    return;
  }

  if (req.method === "GET" && pathname === "/api/live-tanks") {
    const live = loadLiveTanks() || {};
    sendJson(res, 200, { liveTanks: live });
    return;
  }

  if (req.method === "POST" && pathname === "/api/live-tanks") {
    try {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const next = parsed?.liveTanks;
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        sendError(res, 400, "liveTanks payload must be an object");
        return;
      }

      const normalized = {};
      for (const [tank, value] of Object.entries(next)) {
        if (typeof value !== "boolean") {
          sendError(res, 400, `liveTanks.${tank} must be boolean`);
          return;
        }
        normalized[tank] = value;
      }

      await saveLiveTanks(normalized);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.error("POST /api/live-tanks error:", e.message);
      sendError(res, 400, "invalid JSON");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/tanks") {
    const live = loadLiveTanks() || {};
    const all = listTankIds();
    sendJson(res, 200, { tanks: all, liveTanks: live });
    return;
  }

  // --- list recent NDJSON log files for a tank/device ---
  if (req.method === "GET" && pathname === "/api/log-files") {
    const tankId = searchParams.get("tankId");
    if (!tankId) {
      sendError(res, 400, "tankId query parameter is required");
      return;
    }

    const limitRaw = searchParams.get("limit");
    const limit = Math.max(1, Math.min(50, Number(limitRaw || 14)));

    try {
      const files = getLogFilePathsForTank(tankId)
        .map((p) => ({ full: p, meta: statToMeta(p) }))
        .sort((a, b) => Date.parse(b.meta.mtime) - Date.parse(a.meta.mtime))
        .slice(0, limit)
        .map((x) => x.meta);

      sendJson(res, 200, { tankId, files });
    } catch (err) {
      console.error("GET /api/log-files error:", err.message || err);
      sendError(res, 500, "Failed to list log files");
    }
    return;
  }

  // --- download a specific NDJSON log file (validated) ---
  if (req.method === "GET" && pathname === "/api/log-files/download") {
    const tankId = searchParams.get("tankId");
    const file = safeBasename(searchParams.get("file"));

    if (!tankId) {
      sendError(res, 400, "tankId query parameter is required");
      return;
    }
    if (!file) {
      sendError(res, 400, "file query parameter is required");
      return;
    }

    if (!file.includes(`-${tankId}-`) || !file.endsWith(".ndjson")) {
      sendError(res, 400, "Invalid file for tank");
      return;
    }

    const dir = getLogDirectory();
    const fullPath = path.join(dir, file);

    const resolvedDir = path.resolve(dir) + path.sep;
    const resolvedFile = path.resolve(fullPath);
    if (!resolvedFile.startsWith(resolvedDir)) {
      sendError(res, 400, "Invalid file path");
      return;
    }

    if (!fs.existsSync(resolvedFile)) {
      sendError(res, 404, "File not found");
      return;
    }

    res.statusCode = 200;
    setCorsHeaders(res);
    setSecurityHeaders(res);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);

    fs.createReadStream(resolvedFile).pipe(res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/logs") {
    const tankId = searchParams.get("tankId");
    if (!tankId) {
      sendError(res, 400, "tankId query parameter is required");
      return;
    }

    const metricSpec = resolveMetricSpec(searchParams.get("metric"));
    if (!metricSpec) {
      sendError(res, 400, "metric must be 'ph' or 'temp'");
      return;
    }

    const endParam = searchParams.get("end");
    const startParam = searchParams.get("start");
    const endMs = endParam ? Date.parse(endParam) : Date.now();
    const startMs = startParam ? Date.parse(startParam) : endMs - 24 * 60 * 60 * 1000;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      sendError(res, 400, "start and end must be valid ISO timestamps");
      return;
    }

    if (startMs > endMs) {
      sendError(res, 400, "start must be before end");
      return;
    }

    const points = await readLogSeries(tankId, metricSpec, startMs, endMs);
    sendJson(res, 200, {
      tankId,
      metric: metricSpec,
      range: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
      points,
    });
    return;
  }

  // --- Alarm thresholds API ---
  if (req.method === "GET" && pathname === "/api/alarm-thresholds") {
    try {
      const thresholds = getAlarmThresholds();
      sendJson(res, 200, thresholds);
    } catch (err) {
      console.error("GET /api/alarm-thresholds error:", err.message || err);
      sendError(res, 500, "Failed to read alarm thresholds");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/alarm-thresholds") {
    try {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const updated = await setAlarmThresholds(parsed);
      sendJson(res, 200, updated);
    } catch (err) {
      console.error("POST /api/alarm-thresholds error:", err.message || err);
      const message = err?.message || "Invalid alarm thresholds";
      const status = /must be|Missing|payload must be/i.test(message) ? 400 : 500;
      sendError(res, status, message);
    }
    return;
  }

  // --- CO2 config API ---
  if (req.method === "GET" && pathname === "/api/co2/config") {
    try {
      const cfg = loadCo2Config();
      sendJson(res, 200, cfg);
    } catch (err) {
      console.error("GET /api/co2/config error:", err.message || err);
      sendError(res, 500, "Failed to read CO2 config");
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/co2/config") {
    try {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const cfg = {
        defaultLpm: Number(parsed?.defaultLpm ?? 2.5),
        perTank:
          parsed?.perTank && typeof parsed.perTank === "object" ? parsed.perTank : {},
      };

      if (!Number.isFinite(cfg.defaultLpm) || cfg.defaultLpm <= 0) {
        sendError(res, 400, "defaultLpm must be a positive number");
        return;
      }

      await saveCo2Config(cfg);
      sendJson(res, 200, cfg);
    } catch (err) {
      console.error("POST /api/co2/config error:", err.message || err);
      sendError(res, 400, err?.message || "Invalid CO2 config");
    }
    return;
  }

  // --- CO2 daily usage ---
  // GET /api/co2/daily?tankId=Carbonator&date=YYYY-MM-DD&field=timer_seconds
  if (req.method === "GET" && pathname === "/api/co2/daily") {
    const tankId = searchParams.get("tankId");
    const date = searchParams.get("date"); // YYYY-MM-DD (HST day)
    const field = searchParams.get("field") || "timer_seconds";

    if (!tankId) {
      sendError(res, 400, "tankId query parameter is required");
      return;
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendError(res, 400, "date must be YYYY-MM-DD");
      return;
    }

    const cfg = loadCo2Config();
    const lpmRaw = cfg?.perTank?.[tankId] ?? cfg.defaultLpm;
    const lpm = Number(lpmRaw);

    if (!Number.isFinite(lpm) || lpm <= 0) {
      sendError(res, 400, "Configured LPM must be a positive number");
      return;
    }

    const dayStartIso = `${date}T00:00:00-10:00`;
    const dayEndIso = `${date}T24:00:00-10:00`;

    try {
      const secondsOn = await readDailyCounterSeconds(tankId, field, dayStartIso, dayEndIso);
      const liters = (secondsOn / 60) * lpm;

      sendJson(res, 200, {
        tankId,
        date,
        field,
        lpm,
        secondsOn,
        minutesOn: secondsOn / 60,
        liters,
      });
    } catch (err) {
      console.error("GET /api/co2/daily error:", err.message || err);
      sendError(res, 500, "Failed to compute daily CO2 usage");
    }
    return;
  }

  sendError(res, 404, "Not found");
}

let apiServer;

// ---- MQTT wiring ----
const mqttClient = createMqttClient(process.env);

// ---- family discovery ----
// Map config filename to (family id, register map path)
function resolveFamily(configFile) {
  const base = path.basename(configFile);
  if (base === "tankConfig.json")
    return { family: "ctrl", mapFile: "../config/registerMap.json" };
  if (base === "utilityConfig.json")
    return { family: "util", mapFile: "../config/registerMap.json" };
  if (base === "bmmConfig.json")
    return { family: "bmm", mapFile: "../config/registerMap.bmm.json" };
  return null; // ignore unrelated configs
}

// Return array of { family, devicePrefix, mapCtx, blocks, devices[] }
function loadFamilies() {
  const files = fs.readdirSync(configDir).filter((fn) => fn.endsWith("Config.json"));
  const out = [];

  for (const fn of files) {
    const spec = resolveFamily(fn);
    if (!spec) continue;

    const cfgPath = path.join(configDir, fn);
    const devicesJson = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

    const list = Object.entries(devicesJson).map(([tankId, v]) => {
      if (typeof v === "string") return { tankId, ip: v, unitId: 1 };
      return { tankId, ip: v.ip, unitId: v.unitId ?? 1 };
    });

    const live = loadLiveTanks();
    const filtered =
      spec.family === "ctrl" && live
        ? list.filter((d) => live[d.tankId] === true)
        : list;

    if (!filtered.length) {
      console.warn(`⚠️ Family ${spec.family} has no enabled devices`);
      continue;
    }

    const mapCtx = loadRegisterMap(spec.mapFile);
    const blocks = getBlocks(mapCtx);

    out.push({
      family: spec.family,
      devicePrefix: spec.family,
      mapCtx,
      blocks,
      devices: filtered,
    });
  }

  return out;
}

// ---- poller core ----
function fmt(x) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—";
}

async function pollDevice(mqttClient, family, device) {
  const { tankId, ip, unitId } = device;
  const { family: fam, devicePrefix, mapCtx, blocks } = family;

  try {
    const blkBufs = await readBlocksForDevice(ip, blocks, { unitId });
    const values = decodePointsFromBlocks(mapCtx, blkBufs);

    const payload = {
      ts_utc: new Date().toISOString(),
      schema_ver: mapCtx.map?.schema_ver || 1,
      site_id: SITE_ID,
      tank_id: tankId,
      device_id: `${devicePrefix}-${tankId}`,
      fw: DEVICE_FW,
      s: values,
      qc: { status: "ok" },
    };

    updateLiveCache(tankId, fam, ip, payload);

    publishTelemetry(mqttClient, payload, fam);
    processTelemetryForAlarms(payload, fam);

    if (fam === "ctrl" || fam === "util") {
      console.log(
        `✅ ${fam}:${tankId} @ ${ip} → pH=${fmt(values.ph)} temp=${fmt(values.temp1_C)}C`,
      );
    } else if (fam === "bmm") {
      console.log(
        `✅ bmm:${tankId} @ ${ip} → biomass=${fmt(values.biomass)} ch_clear=${fmt(values.ch_clear)}`,
      );
    } else {
      console.log(`✅ ${fam}:${tankId} @ ${ip}`);
    }
  } catch (e) {
    const failPayload = {
      ts_utc: new Date().toISOString(),
      site_id: SITE_ID,
      tank_id: tankId,
      device_id: `${family.devicePrefix}-${tankId}`,
      fw: DEVICE_FW,
      s: {},
      qc: { status: "fail", error: e.message },
    };

    // IMPORTANT: update live cache on failure too (so util stays visible + status updates)
    updateLiveCache(tankId, fam, ip, failPayload);

    publishTelemetry(mqttClient, failPayload, fam);
    processTelemetryForAlarms(failPayload, fam, { error: e });

    console.error(`❌ ${family.family}:${tankId} @ ${ip}: ${e.message}`);
  }
}

async function pollAllFamilies(mqttClient, families) {
  const work = families.flatMap((f) => f.devices.map((d) => ({ f, d })));
  if (!work.length) return;

  let i = 0;
  const N = Math.min(CONCURRENCY, work.length);

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= work.length) break;
      const { f, d } = work[idx];
      if (idx % 3 === 0) await new Promise((r) => setTimeout(r, Math.random() * 200));
      await pollDevice(mqttClient, f, d);
    }
  }

  await Promise.all(Array.from({ length: N }, worker));
}

// ---- main loop + reload ----
initLogger();

let families = loadFamilies();
console.log(
  `👟 Gateway starting: site=${SITE_ID}, interval=${POLL_MS}ms, concurrency=${CONCURRENCY}`,
);
console.log(
  `📦 Families loaded: ${families.map((f) => `${f.family}(${f.devices.length})`).join(", ")}`,
);

let lastReload = Date.now();

async function tick() {
  const now = Date.now();
  if (now - lastReload >= FAMILY_RELOAD_MS) {
    lastReload = now;
    try {
      families = loadFamilies();
      console.log(
        `🔁 Families reloaded: ${families.map((f) => `${f.family}(${f.devices.length})`).join(", ")}`,
      );
    } catch (e) {
      console.error("Family reload error:", e.message);
    }
  }

  await pollAllFamilies(mqttClient, families);
  await flushAlarmBatch(); // one Slack message per poll
}

let pollTimer;

function start() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    tick().catch((e) => console.error("Poll error:", e.message));
  }, POLL_MS);
  tick().catch((e) => console.error("Initial poll error:", e.message));

  apiServer = http.createServer((req, res) => {
    handleApiRequest(req, res).catch((err) => {
      console.error("API handler error:", err.message || err);
      if (!res.writableEnded) {
        try {
          sendError(res, 500, "Internal server error");
        } catch {}
      }
    });
  });

  apiServer.listen(API_PORT, API_HOST, () => {
    console.log(`🌐 HTTP API listening on http://${API_HOST}:${API_PORT}`);
  });
}

// ---- graceful shutdown ----
async function shutdown() {
  console.log("Shutting down…");
  if (pollTimer) clearInterval(pollTimer);
  try {
    await shutdownLogger();
  } catch {}
  if (apiServer) {
    await new Promise((resolve) => apiServer.close(resolve));
  }
  mqttClient?.end(true, () => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// kick it off
start();
