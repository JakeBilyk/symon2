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

// Slack Incoming Webhook URL from env
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

// Alarm rule definitions
const ALARM_RULES = [
  {
    id: "ctrl_ph_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "ph",
    low: 7.2,
    high: 8.2,
    severity: "warning",
    description: "pH",
  },
  {
    id: "ctrl_temp_out_of_range",
    family: "ctrl",
    type: "metric_threshold",
    metric: "temp1_C",
    low: 18,
    high: 27.5,
    severity: "warning",
    description: "Temp",
  },
  {
    id: "qc_fail",
    family: null, // all families
    type: "qc_fail",
    severity: "error",
    description: "Connection",
  },
];

// In-memory state so we don't spam Slack every poll.
// Key: `${ruleId}|${tankId}`
const alarmState = new Map();

// Events waiting to be batched into the next Slack message
const pendingEvents = [];

/**
 * Entry point: call this for every telemetry payload.
 * We just compute rule state changes and stash events; we
 * don't talk to Slack directly here anymore.
 *
 * @param {object} payload  telemetry frame
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
        const err =
          payload?.qc?.error || opts.error?.message || "Unknown error";
        details = `QC fail: ${err}`;
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

/**
 * Flush all pending alarm events into a single batched Slack message.
 * Call this once per polling period (after pollAllFamilies).
 */
export async function flushAlarmBatch() {
  if (!WEBHOOK_URL) return;
  if (pendingEvents.length === 0) return;

  // Group events by tank/family for nicer formatting
  const byTank = new Map();
  for (const evt of pendingEvents) {
    const key = `${evt.family}|${evt.tankId}`;
    if (!byTank.has(key)) {
      byTank.set(key, []);
    }
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
      const sevSet = new Set(
        alarms.map((e) => (e.rule.severity || "info").toUpperCase()),
      );
      const sevLabel = sevSet.size === 1 ? [...sevSet][0] : "MIXED";

      for (const e of alarms) {
        const label = e.rule.description || e.rule.id;
        lines.push(
          `• ${label}` + (e.details ? ` — ${e.details}` : ""),
        );
      }
    }

    if (resolves.length > 0) {
      if (alarms.length > 0) lines.push(""); // blank line between sections
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

  // Build one big Slack message for all tanks in this poll
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
    pendingEvents.length = 0; // clear batch either way
  }
}

/**
 * Track rule state; return an event object when it changes.
 */
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

  // No state change → no event
  if (active === prev.active) {
    return null;
  }

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
