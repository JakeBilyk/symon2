// alarmService.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// --- resolve correct .env path ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend/.env (one directory up from src/)
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import https from "https";
import { URL } from "url";

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

// Basic rule definitions – tweak thresholds as needed.
const ALARM_RULES = [
  {
    id: "ctrl_ph_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "ph",
    low: 7.2,
    high: 8.2,
    severity: "warning",
    description: "pH out of target range 7.2–8.2",
  },
  {
    id: "ctrl_temp_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "temp1_C",
    low: 18,
    high: 30,
    severity: "warning",
    description: "Temperature out of target range 18–30 °C",
  },
  {
    id: "qc_fail",
    family: null, // all families
    type: "qc_fail",
    severity: "error",
    description: "Polling / device quality check failed",
  },
];

// In-memory state so we don't spam Slack each poll.
// Key: `${ruleId}|${tankId}`
const alarmState = new Map();

/**
 * Entry point: call this for every telemetry payload.
 * @param {object} payload  telemetry frame (same as publishTelemetry)
 * @param {string} family   "ctrl" | "util" | "bmm"
 * @param {object} [opts]   { error?: Error }
 */
export function processTelemetryForAlarms(payload, family, opts = {}) {
  if (!WEBHOOK_URL) {
    // Alarms disabled if no webhook configured
    return;
  }

  const tankId = payload?.tank_id;
  if (!tankId) return;

  const qcStatus = payload?.qc?.status || "ok";
  const s = payload?.s || {};
  const now = Date.now();

  for (const rule of ALARM_RULES) {
    if (rule.family && rule.family !== family) continue;

    let active = false;
    let details = "";

    if (rule.type === "metric_threshold") {
      const value = s[rule.metric];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      const tooLow =
        typeof rule.low === "number" && value < rule.low;
      const tooHigh =
        typeof rule.high === "number" && value > rule.high;
      active = tooLow || tooHigh;
      if (active) {
        const dir = tooLow ? "LOW" : "HIGH";
        details = `${rule.metric}=${value.toFixed(2)} (${dir}) thresholds [${rule.low}, ${rule.high}]`;
      }
    } else if (rule.type === "qc_fail") {
      active = qcStatus === "fail";
      if (active) {
        const err = payload?.qc?.error || opts.error?.message || "Unknown error";
        details = `qc.status=fail ${err}`;
      }
    }

    updateRuleState(rule, tankId, family, payload, active, details, now);
  }
}

/**
 * Decide whether to send trigger / resolve messages.
 */
function updateRuleState(rule, tankId, family, payload, active, details, now) {
  const key = `${rule.id}|${tankId}`;
  const prev = alarmState.get(key) || { active: false, lastChange: 0 };
  if (active === prev.active) {
    return;
  }

  alarmState.set(key, { active, lastChange: now });

  const site = payload?.site_id || "unknown-site";
  const device = payload?.device_id || `${family}-${tankId}`;
  const when = payload?.ts_utc || new Date().toISOString();

  if (active) {
    const text =
      `:rotating_light: *ALARM* (${rule.severity.toUpperCase()})\n` +
      `*${rule.description}*\n` +
      `• Site: \`${site}\`\n` +
      `• Tank: \`${tankId}\` (${family})\n` +
      `• Device: \`${device}\`\n` +
      (details ? `• Details: ${details}\n` : "") +
      `• At: ${when}`;

    postToSlack(text).catch((e) => {
      console.error("Slack alarm send failed:", e.message);
    });
  } else {
    const text =
      `:white_check_mark: *RESOLVED*\n` +
      `*${rule.description}*\n` +
      `• Site: \`${site}\`\n` +
      `• Tank: \`${tankId}\` (${family})\n` +
      `• Device: \`${device}\`\n` +
      (details ? `• Last condition: ${details}\n` : "") +
      `• Cleared at: ${new Date().toISOString()}`;

    postToSlack(text).catch((e) => {
      console.error("Slack resolve send failed:", e.message);
    });
  }
}

/**
 * Post a plain text message to Slack Incoming Webhook.
 * Uses Node's https module so no extra deps.
 */
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
        // Drain response
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(`Slack webhook HTTP ${res.statusCode || "?"}`)
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
