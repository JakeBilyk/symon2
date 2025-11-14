import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import mqtt from "mqtt";

import { loadRegisterMap, getBlocks, decodePointsFromBlocks } from "./registerMap.js";
import { readBlocksForDevice } from "./modbusBlocks.js";
import { initLogger, logTelemetry, shutdownLogger, getLogDirectory } from "./loggingService.js";

// ---- path helpers ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const configDir  = path.join(__dirname, "..", "config");

// ---- env / runtime knobs ----
const SITE_ID        = process.env.SITE_ID || "dev01";
const DEVICE_FW      = "gw-1.0.0";
const POLL_MS        = Number(process.env.POLL_MS || 60_000);     // polling cadence
const CONCURRENCY    = Number(process.env.POLL_CONCURRENCY || 8); // worker pool size
const FAMILY_RELOAD_MS = Number(process.env.FAMILY_RELOAD_MS || 5 * 60_000);
const API_PORT       = Number(process.env.API_PORT || 4000);
const API_HOST       = process.env.API_HOST || "0.0.0.0";

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
    return Object.keys(data || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
  if (!res.hasHeader("Cache-Control")) {
    res.setHeader("Cache-Control", "no-cache");
  }
  res.removeHeader("X-Powered-By");
  res.removeHeader("Server");
  res.setHeader("Server", "");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  setSecurityHeaders(res);
}

function ensureJsonHeaders(res) {
  if (!res.hasHeader("Content-Type")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
}

function sendJson(res, status, payload) {
  if (!res.headersSent) {
    setCorsHeaders(res);
    ensureJsonHeaders(res);
    res.statusCode = status;
  }
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
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

function resolveMetricSpec(rawMetric) {
  const m = (rawMetric || "ph").toLowerCase();
  if (["temp", "temp_c", "temperature", "temp1_c"].includes(m)) {
    return { id: "temp", key: "temp1_C", label: "Temperature (°C)" };
  }
  if (["ph", "pH"].includes(m)) {
    return { id: "ph", key: "ph", label: "pH" };
  }
  return null;
}

async function readLogSeries(tankId, metricSpec, startMs, endMs) {
  try {
    const dir = getLogDirectory();
    const files = await fsp.readdir(dir);
    const prefix = "telemetry-ctrl-";
    const out = [];

    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(".ndjson")) continue;
      const fullPath = path.join(dir, file);
      let raw;
      try {
        raw = await fsp.readFile(fullPath, "utf8");
      } catch (e) {
        console.error("log read error:", file, e.message);
        continue;
      }

      for (const line of raw.split(/\n+/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if ((row?.tank_id || row?.tankId) !== tankId) continue;
          const tsMs = Date.parse(row?.ts_utc || row?.tsUtc || row?.tsUTC);
          if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;

          const value = Number(row?.[metricSpec.key]);
          if (!Number.isFinite(value)) continue;

          out.push({ ts: new Date(tsMs).toISOString(), value });
        } catch (e) {
          console.error("log parse error:", file, e.message);
        }
      }
    }

    out.sort((a, b) => a.ts.localeCompare(b.ts));
    return out;
  } catch (e) {
    console.error("readLogSeries error:", e.message);
    return [];
  }
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
          sendError(res, 400, `tank "${tank}" must map to a boolean`);
          return;
        }
        normalized[tank] = value;
      }

      await saveLiveTanks(normalized);
      families = loadFamilies();
      sendJson(res, 200, { ok: true, liveTanks: normalized });
    } catch (e) {
      console.error("live-tanks save error:", e.message);
      sendError(res, 500, "failed to persist liveTanks");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/tanks") {
    const tanks = listTankIds();
    const live = loadLiveTanks() || {};
    sendJson(res, 200, { tanks, liveTanks: live });
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

  sendError(res, 404, "Not found");
}


let apiServer;

// ---- MQTT wiring ----
function createMqttUrl() {
  const host = process.env.MQTT_HOST || "localhost";
  const port = Number(process.env.MQTT_PORT || 1883);
  const proto = process.env.MQTT_TLS === "1" ? "mqtts" : "mqtt";
  return `${proto}://${host}:${port}`;
}

function createMqttClient() {
  const url = createMqttUrl();
  const opts = {
    username: process.env.MQTT_USER || undefined,
    password: process.env.MQTT_PASS || undefined,
    reconnectPeriod: 2000,
    keepalive: 30,
    clean: true,
  };
  const client = mqtt.connect(url, opts);
  client.on("connect", () => console.log(`✅ MQTT connected → ${url}`));
  client.on("error", (e) => console.error("MQTT error:", e.message));
  client.on("close", () => console.log("MQTT connection closed"));
  return client;
}

function publishTelemetry(mqttClient, payload) {
  const tankId   = payload.tank_id;
  const deviceId = payload.device_id;
  const topic = `symbrosia/${payload.site_id}/${tankId}/${deviceId}/telemetry`;
  mqttClient.publish(topic, JSON.stringify(payload), { qos: 0, retain: false });
}

// ---- family discovery ----
// Map config filename to (family id, register map path)
function resolveFamily(configFile) {
  const base = path.basename(configFile);
  if (base === "tankConfig.json")    return { family: "ctrl", mapFile: "../config/registerMap.json" };
  if (base === "utilityConfig.json") return { family: "util", mapFile: "../config/registerMap.json" };
  if (base === "bmmConfig.json")     return { family: "bmm",  mapFile: "../config/registerMap.bmm.json" };
  return null; // ignore unrelated configs
}

// Return array of { family, devicePrefix, mapCtx, blocks, devices[] }
function loadFamilies() {
  const files = fs.readdirSync(configDir).filter(fn => fn.endsWith("Config.json"));
  const out = [];

  for (const fn of files) {
    const spec = resolveFamily(fn);
    if (!spec) continue;

    const cfgPath = path.join(configDir, fn);
    const devicesJson = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

    // Normalize device list
    const list = Object.entries(devicesJson).map(([tankId, v]) => {
      if (typeof v === "string") return { tankId, ip: v, unitId: 1 };
      return { tankId, ip: v.ip, unitId: v.unitId ?? 1 };
    });

    // Filter inactive controller tanks if liveTanks provided
    const liveTanks = loadLiveTanks(); // read on each reload
    // Skip tanks marked false for controllers and BMMs
    const needsLiveFilter = (spec.family === "ctrl" || spec.family === "bmm");
    const filtered = (needsLiveFilter && liveTanks)
      ? list.filter(d => liveTanks[d.tankId] !== false) // default allow if key missing
      : list;
      if (needsLiveFilter && liveTanks) {
        const skipped = list.length - filtered.length;
        if (skipped > 0) {
         console.log(`🚫 ${spec.family}: skipping ${skipped} tank(s) due to liveTanks.json`);
  }
}



    // Load register map + read blocks for this family
    const mapCtx = loadRegisterMap(spec.mapFile);
    const blocks = getBlocks(mapCtx);

    out.push({
      family: spec.family,             // "ctrl" | "util" | "bmm"
      devicePrefix: spec.family,       // used to build device_id
      mapCtx,
      blocks,
      devices: filtered
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
    const values  = decodePointsFromBlocks(mapCtx, blkBufs);

    const payload = {
      ts_utc: new Date().toISOString(),
      schema_ver: mapCtx.map?.schema_ver || 1,
      site_id: SITE_ID,
      tank_id: tankId,
      device_id: `${devicePrefix}-${tankId}`,
      fw: DEVICE_FW,
      s: values,
      qc: { status: "ok" }
    };

    publishTelemetry(mqttClient, payload);
    await logTelemetry(payload);

    // Friendly per-family log
    if (fam === "ctrl" || fam === "util") {
      console.log(`✅ ${fam}:${tankId} @ ${ip} → pH=${fmt(values.ph)} temp=${fmt(values.temp1_C)}C`);
    } else if (fam === "bmm") {
      console.log(`✅ bmm:${tankId} @ ${ip} → biomass=${fmt(values.biomass)} ch_clear=${fmt(values.ch_clear)}`);
    } else {
      console.log(`✅ ${fam}:${tankId} @ ${ip}`);
    }
  } catch (e) {
    // Publish fail frame so downstream can detect staleness
    publishTelemetry(mqttClient, {
      ts_utc: new Date().toISOString(),
      site_id: SITE_ID,
      tank_id: tankId,
      device_id: `${family.devicePrefix}-${tankId}`,
      fw: DEVICE_FW,
      s: {},
      qc: { status: "fail", error: e.message }
    });
    console.error(`❌ ${family.family}:${tankId} @ ${ip}: ${e.message}`);
  }
}

async function pollAllFamilies(mqttClient, families) {
  const work = families.flatMap(f => f.devices.map(d => ({ f, d })));
  if (!work.length) return;

  let i = 0;
  const N = Math.min(CONCURRENCY, work.length);

  async function worker() {
    while (i < work.length) {
      const idx = i++;
      const { f, d } = work[idx];
      // small jitter to avoid Wi-Fi bursts
      if (idx % 3 === 0) await new Promise(r => setTimeout(r, Math.random() * 200));
      await pollDevice(mqttClient, f, d);
    }
  }

  await Promise.all(Array.from({ length: N }, worker));
}

// ---- main loop + reload ----
const mqttClient = createMqttClient();
initLogger();

let families = loadFamilies();
console.log(`👟 Gateway starting: site=${SITE_ID}, interval=${POLL_MS}ms, concurrency=${CONCURRENCY}`);
console.log(`📦 Families loaded: ${families.map(f => `${f.family}(${f.devices.length})`).join(", ")}`);

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

let pollTimer;
function start() {
  const run = async () => {
    try {
      await pollAllFamilies(mqttClient, families);
    } catch (e) {
      console.error("Cycle error:", e);
    }
  };

  // start with slight jitter
  setTimeout(run, Math.floor(Math.random() * 400));
  pollTimer = setInterval(run, POLL_MS);

  // periodic config reload (cheap)
  setInterval(() => {
    try {
      families = loadFamilies();
      console.log(`🔁 Families reloaded: ${families.map(f => `${f.family}(${f.devices.length})`).join(", ")}`);
    } catch (e) {
      console.error("Family reload failed:", e.message);
    }
  }, FAMILY_RELOAD_MS);
}

// ---- graceful shutdown ----
async function shutdown() {
  console.log("Shutting down…");
  if (pollTimer) clearInterval(pollTimer);
  try { await shutdownLogger(); } catch {}
  if (apiServer) {
    await new Promise((resolve) => apiServer.close(resolve));
  }
  mqttClient?.end(true, () => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// kick it off
start();
