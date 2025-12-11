// backend/src/alarmService.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { promises as fsp } from "fs";
import https from "https";
import { URL } from "url";

// --- resolve .env path ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

// How long a tank can go without a successful poll before we alarm (in minutes)
const CONNECTIVITY_ALARM_MINUTES = Number(
  process.env.CONNECTIVITY_ALARM_MINUTES || 60,
);
const CONNECTIVITY_ALARM_MS = CONNECTIVITY_ALARM_MINUTES * 60_000;

// Where alarm settings are persisted
const SETTINGS_PATH = path.join(__dirname, "..", "data", "alarm-settings.json");

// Default config
const DEFAULT_CONFIG = {
  ph: { low: 7.2, high: 8.2 },
  temp: { low: 18, high: 27.5 },
  connectivity: {
    qcAlarmsEnabled: true,
  },
};

// Alarm rules; ph/temp thresholds will be kept in sync with config
const ALARM_RULES = [
  {
    id: "ctrl_ph_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "ph",
    low: DEFAULT_CONFIG.ph.low,
    high: DEFAULT_CONFIG.ph.high,
    severity: "warning",
    description: "pH",
  },
  {
    id: "ctrl_temp_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "temp1_C",
    low: DEFAULT_CONFIG.temp.low,
    high: DEFAULT_CONFIG.temp.high,
    severity: "warning",
    description: "Temp",
  },
  {
    id: "qc_fail",
    family: null,
    type: "qc_fail",
    severity: "error",
    description: "Connection",
  },
];

// Per-tank connectivity state for offline duration
// key: tankId -> { lastOk: number | null, firstFail: number | null, consecutiveFails: number }
const connectivityState = new Map();

// Alarm state so we don't spam Slack
// key: `${ruleId}|${tankId}`
const alarmState = new Map();

// Events waiting for batch send
const pendingEvents = [];

// Current config in memory
let currentConfig = loadConfigFromDisk();
applyConfigToRules(currentConfig);

/* ------------------------------------------------------------------ */
/*                 Main entry: process telemetry frame                 */
/* ------------------------------------------------------------------ */

export function processTelemetryForAlarms(payload, family, opts = {}) {
  if (!WEBHOOK_URL) return;

  const tankId = payload?.tank_id;
  if (!tankId) return;

  const qcStatus = payload?.qc?.status || "ok";
  const s = payload?.s || {};
  const now = Date.now();

  // --- update per-tank connectivity state ---
  let conn = connectivityState.get(tankId);
  if (!conn) {
    conn = { lastOk: null, firstFail: null, consecutiveFails: 0 };
  }

  if (qcStatus === "ok") {
    conn.lastOk = now;
    conn.firstFail = null;
    conn.consecutiveFails = 0;
  } else if (qcStatus === "fail") {
    conn.consecutiveFails += 1;
    if (!conn.firstFail) {
      conn.firstFail = now;
    }
  }
  connectivityState.set(tankId, conn);
  // ------------------------------------------

  for (const rule of ALARM_RULES) {
    if (rule.family && rule.family !== family) continue;

    let active = false;
    let details = "";

    if (rule.type === "metric_threshold") {
      const value = s[rule.metric];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;

      const tooLow = typeof rule.low === "number" && value < rule.low;
      const tooHigh = typeof rule.high === "number" && value > rule.high;
      active = tooLow || tooHigh;

      if (active) {
        const dir = tooLow ? "LOW" : "HIGH";
        details = `${rule.metric}=${value.toFixed(
          2,
        )} (${dir}) thresholds [${rule.low}, ${rule.high}]`;
      }
    } else if (rule.type === "qc_fail") {
      // NEW: allow techs to disable QC / connection alarms entirely
      if (!currentConfig.connectivity.qcAlarmsEnabled) {
        continue; // skip state updates and events for this rule
      }

      const err =
        payload?.qc?.error || opts.error?.message || "Unknown error";

      if (qcStatus === "fail") {
        // How long since last successful poll?
        let offlineMs = 0;
        if (conn.lastOk) {
          offlineMs = now - conn.lastOk;
        } else if (conn.firstFail) {
          offlineMs = now - conn.firstFail;
        }

        const offlineMinutes = offlineMs / 60000;
        const overThreshold = offlineMs >= CONNECTIVITY_ALARM_MS;

        active = overThreshold;

        if (active) {
          details = `No successful poll for ~${offlineMinutes.toFixed(
            0,
          )} min; last error: ${err}`;
        }
      } else {
        // qcStatus === "ok" → clear any existing connectivity alarm
        active = false;
      }
    }

    const evt = updateRuleState(
      rule,
      tankId,
      family,
      payload,
      active,
      details,
      now,
    );
    if (evt) {
      pendingEvents.push(evt);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                   Batch + send to Slack (unchanged)                */
/* ------------------------------------------------------------------ */

export async function flushAlarmBatch() {
  if (!WEBHOOK_URL) return;
  if (pendingEvents.length === 0) return;

  const byTank = new Map();
  for (const evt of pendingEvents) {
    const key = `${evt.family}|${evt.tankId}`;
    if (!byTank.has(key)) byTank.set(key, []);
    byTank.get(key).push(evt);
  }

  const tankBlocks = [];

  for (const [, events] of byTank.entries()) {
    const { tankId, family } = events[0];
    const alarms = events.filter((e) => e.kind === "ALARM");
    const resolves = events.filter((e) => e.kind === "RESOLVED");

    if (alarms.length === 0 && resolves.length === 0) continue;

    const lines = [];
    lines.push(`*Tank:* \`${tankId}\` (${family})`);

    if (alarms.length > 0) {
      for (const e of alarms) {
        const label = e.rule.description || e.rule.id;
        lines.push(`• ${label}` + (e.details ? ` — ${e.details}` : ""));
      }
    }

    if (resolves.length > 0) {
      if (alarms.length > 0) lines.push("");
      lines.push(`:white_check_mark: *RESOLVED*`);
      for (const e of resolves) {
        const label = e.rule.description || e.rule.id;
        lines.push(
          `• ${label}` +
            (e.details ? ` — last condition: ${e.details}` : ""),
        );
      }
    }

    tankBlocks.push(lines.join("\n"));
  }

  if (tankBlocks.length === 0) {
    pendingEvents.length = 0;
    return;
  }

  const text = tankBlocks.join("\n\n");

  try {
    await postToSlack(text);
  } catch (e) {
    console.error("Slack alarm batch send failed:", e.message);
  } finally {
    pendingEvents.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*      NEW: public getters/setters (used by /api + Settings page)    */
/* ------------------------------------------------------------------ */

export function getAlarmThresholds() {
  // shallow clone to avoid external mutation
  return {
    ph: { ...currentConfig.ph },
    temp: { ...currentConfig.temp },
    connectivity: { ...currentConfig.connectivity },
  };
}

export async function setAlarmThresholds(payload) {
  const next = normalizeConfig(payload);

  currentConfig = next;
  applyConfigToRules(next);

  try {
    await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fsp.writeFile(
      SETTINGS_PATH,
      JSON.stringify(next, null, 2),
      "utf8",
    );
  } catch (err) {
    console.error("Failed to persist alarm settings:", err.message);
    throw new Error("Failed to persist alarm settings");
  }

  return getAlarmThresholds();
}

/* ------------------------------------------------------------------ */
/*                        Internal helpers                             */
/* ------------------------------------------------------------------ */

function loadConfigFromDisk() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return cloneDefaultConfig();
    }
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (err) {
    console.error(
      "Failed to load alarm settings from disk, using defaults:",
      err.message,
    );
    return cloneDefaultConfig();
  }
}

function cloneDefaultConfig() {
  return {
    ph: { ...DEFAULT_CONFIG.ph },
    temp: { ...DEFAULT_CONFIG.temp },
    connectivity: { ...DEFAULT_CONFIG.connectivity },
  };
}

function validateThresholdBlock(name, block, fallback) {
  const src = block && typeof block === "object" ? block : fallback;
  const low = Number(src.low);
  const high = Number(src.high);

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new Error(`${name} thresholds must be numeric`);
  }
  if (low >= high) {
    throw new Error(`${name} low must be less than high`);
  }

  return { low, high };
}

function normalizeConfig(obj) {
  if (!obj || typeof obj !== "object") obj = {};

  const ph = validateThresholdBlock("ph", obj.ph, DEFAULT_CONFIG.ph);
  const temp = validateThresholdBlock(
    "temp",
    obj.temp,
    DEFAULT_CONFIG.temp,
  );

  const connRaw = obj.connectivity || {};
  const qcAlarmsEnabled =
    typeof connRaw.qcAlarmsEnabled === "boolean"
      ? connRaw.qcAlarmsEnabled
      : true;

  return {
    ph,
    temp,
    connectivity: { qcAlarmsEnabled },
  };
}

function applyConfigToRules(config) {
  for (const rule of ALARM_RULES) {
    if (rule.type !== "metric_threshold") continue;
    if (rule.metric === "ph") {
      rule.low = config.ph.low;
      rule.high = config.ph.high;
    } else if (rule.metric === "temp1_C") {
      rule.low = config.temp.low;
      rule.high = config.temp.high;
    }
  }
}

function updateRuleState(
  rule,
  tankId,
  family,
  payload,
  active,
  details,
  now,
) {
  const key = `${rule.id}|${tankId}`;
  const prev = alarmState.get(key) || { active: false, lastChange: 0 };
  if (active === prev.active) return null;

  alarmState.set(key, { active, lastChange: now });

  return {
    kind: active ? "ALARM" : "RESOLVED",
    rule,
    tankId,
    family,
    details,
    payload,
    ts: now,
  };
}

function postToSlack(text) {
  return new Promise((resolve, reject) => {
    if (!WEBHOOK_URL) {
      return reject(new Error("SLACK_WEBHOOK_URL not configured"));
    }

    const url = new URL(WEBHOOK_URL);
    const body = JSON.stringify({ text });

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(`Slack webhook HTTP ${res.statusCode || "?"}`),
            );
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
