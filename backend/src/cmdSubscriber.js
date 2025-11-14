import { planWrite, loadRegisterMap, getBlocks, decodePointsFromBlocks } from "./registerMap.js";
import { readBlocksForDevice, writeRegisters } from "./modbusBlocks.js";
import { publishTelemetry } from "./mqttPublisher.js";

const DEFAULTS = {
  topicPattern: "symbrosia/+/+/+/cmd",   // site/tank/device scoped
  ackSuffix: "cmd/ack",
  ttlSec: 30,
  // simple rate-limit per device:
  maxOpsPerMinute: 20
};

// in-memory simple leaky bucket per device
const opBuckets = new Map(); // key=deviceKey, value={tokens, lastRefill}

function tokenBucketAllow(deviceKey, maxPerMin) {
  const now = Date.now();
  let b = opBuckets.get(deviceKey);
  if (!b) { b = { tokens: maxPerMin, lastRefill: now }; opBuckets.set(deviceKey, b); }
  const elapsedMin = (now - b.lastRefill) / 60000;
  if (elapsedMin >= 1) {
    const add = Math.floor(elapsedMin * maxPerMin);
    b.tokens = Math.min(maxPerMin, b.tokens + add);
    b.lastRefill = now;
  }
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}

/**
 * Attach command subscriber.
 * @param {import('mqtt').MqttClient} mqtt
 * @param {{
 *   siteId: string,
 *   tankMap: Record<string,string>, // { tankId: ip }
 *   afterWriteRepublish?: (ctx) => Promise<void>|void,
 *   topicPattern?: string,
 *   ackSuffix?: string,
 *   ttlSec?: number,
 *   maxOpsPerMinute?: number
 * }} cfg
 */
export function attachCmdSubscriber(mqtt, cfg) {
  const { map } = loadRegisterMap();
  const blocks = getBlocks({ map });
  const topicPattern = cfg.topicPattern || DEFAULTS.topicPattern;
  const ackSuffix = cfg.ackSuffix || DEFAULTS.ackSuffix;
  const ttlSec = cfg.ttlSec ?? DEFAULTS.ttlSec;
  const maxOpsPerMinute = cfg.maxOpsPerMinute ?? DEFAULTS.maxOpsPerMinute;

  mqtt.subscribe(topicPattern, { qos: 1 }, (err) => {
    if (err) console.error("CMD subscribe error:", err);
    else console.log(`✅ Subscribed to ${topicPattern}`);
  });

  mqtt.on("message", async (topic, buf) => {
    if (!topic.endsWith("/cmd")) return; // ignore other topics

    // Parse topic parts: symbrosia/{site}/{tank}/{device}/cmd
    const parts = topic.split("/");
    if (parts.length < 6) return;
    const [_, site, tank, device] = parts; // ignore 'symbrosia' and trailing 'cmd'

    // Parse command JSON
    let cmd;
    try { cmd = JSON.parse(buf.toString()); }
    catch { return publishAck(mqtt, parts, ackSuffix, { error: "bad_json" }); }

    // TTL check
    if (!validTtl(cmd, ttlSec)) {
      return publishAck(mqtt, parts, ackSuffix, { tx_id: cmd?.tx_id, error: "expired" });
    }

    // Rate limit per device
    const deviceKey = `${site}/${tank}/${device}`;
    if (!tokenBucketAllow(deviceKey, maxOpsPerMinute)) {
      return publishAck(mqtt, parts, ackSuffix, { tx_id: cmd?.tx_id, error: "rate_limited" });
    }

    // Resolve IP
    const ip = cfg.tankMap?.[tank];
    if (!ip) {
      return publishAck(mqtt, parts, ackSuffix, { tx_id: cmd?.tx_id, error: "unknown_tank" });
    }

    // Execute ops sequentially (or change to parallel if your controller allows)
    const results = [];
    for (const op of cmd.ops || []) {
      try {
        const plan = planWrite({ map }, op.point, op.value, { allowClamp: true });
        // Convert words (array of Buffers) → array of u16 values for FC16
        const wordU16 = [];
        for (const w of plan.words) wordU16.push(w.readUInt16BE(0));
        await writeRegisters(ip, plan.fc, plan.start, wordU16);
        results.push({ point: op.point, ok: true, reason: plan.reason, value_applied: plan.value });
      } catch (e) {
        results.push({ point: op.point, ok: false, error: e.message });
      }
    }

    // Publish ACK
    await publishAck(mqtt, parts, ackSuffix, {
      tx_id: cmd.tx_id,
      ts_utc: new Date().toISOString(),
      requested_by: cmd.requested_by,
      results
    });

    // Optional: re-read & republish telemetry so UIs reflect confirmed state
    try {
      if (typeof cfg.afterWriteRepublish === "function") {
        await cfg.afterWriteRepublish({ ip, site, tank, device });
      } else {
        // default: read all blocks and publish a telemetry snapshot
        const blkBufs = await readBlocksForDevice(ip, blocks);
        const values = decodePointsFromBlocks({ map }, blkBufs);
        const payload = {
          ts_utc: new Date().toISOString(),
          schema_ver: map.schema_ver || 1,
          site_id: site,
          tank_id: tank,
          device_id: device,
          fw: "gw-1.0.0",
          s: values,
          qc: { status: "ok" }
        };
        publishTelemetry(mqtt, payload);
      }
    } catch (e) {
      console.warn(`Post-write republish failed for ${deviceKey}:`, e.message);
    }
  });
}

function validTtl(cmd, ttlSec) {
  if (!cmd?.ts_utc) return true; // if not provided, accept
  const t = Date.parse(cmd.ts_utc);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 1000 <= (ttlSec ?? 30);
}

function publishAck(mqtt, topicParts, ackSuffix, body) {
  const base = topicParts.slice(0, -1).join("/"); // drop 'cmd'
  const ackTopic = `${base}/${ackSuffix}`;
  mqtt.publish(ackTopic, JSON.stringify(body), { qos: 1 });
}
