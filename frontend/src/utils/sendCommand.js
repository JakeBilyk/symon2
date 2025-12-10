// src/utils/sendCommand.js
import mqtt from "mqtt";

const SITE_ID = "dev01";
const ACK_TIMEOUT_MS = 5000;

// Singleton MQTT client + pending command map
let client = null;
let clientReadyPromise = null;
const pending = new Map(); // tx_id -> { resolve, reject, timeoutId }

// Ensure MQTT client exists and is connected
function ensureClient() {
  if (client && client.connected) {
    return Promise.resolve(client);
  }

  if (!clientReadyPromise) {
    const url = import.meta.env.VITE_MQTT_URL;
    const user = import.meta.env.VITE_MQTT_USER;
    const pass = import.meta.env.VITE_MQTT_PASS;

    if (!url) {
      return Promise.reject(new Error("VITE_MQTT_URL is not configured"));
    }

    client = mqtt.connect(url, {
      username: user || undefined,
      password: pass || undefined,
      keepalive: 30,
      reconnectPeriod: 2000
    });

    clientReadyPromise = new Promise((resolve, reject) => {
      const onConnect = () => {
        // Subscribe once for all ACKs from this site
        client.subscribe(`symbrosia/${SITE_ID}/+/+/cmd/ack`, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(client);
        });
      };

      const onError = (err) => {
        reject(err);
      };

      client.once("connect", onConnect);
      client.once("error", onError);
    });

    // Global message handler: route ACKs by tx_id
    client.on("message", (topic, buf) => {
      try {
        const payload = JSON.parse(buf.toString());
        const txId = payload?.tx_id;
        if (!txId || !pending.has(txId)) return;

        const { resolve, reject, timeoutId } = pending.get(txId);
        clearTimeout(timeoutId);
        pending.delete(txId);

        if (payload.error) {
          reject(new Error(payload.error));
          return;
        }

        // If there are per-op results, surface failures
        const results = payload.results || [];
        const failed = results.find((r) => r && r.ok === false);
        if (failed) {
          reject(new Error(failed.error || `Command failed for point ${failed.point}`));
          return;
        }

        resolve(payload);
      } catch (e) {
        // Ignore malformed messages
        // console.error("ACK parse error:", e.message);
      }
    });
  }

  return clientReadyPromise;
}

function createTxId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Low-level command sender.
 * @param {string} tankId
 * @param {string} deviceId - e.g. "ctrl-C15"
 * @param {Array<{point:string, value:number}>} ops
 * @returns {Promise<object>} resolves with ACK payload
 */
export async function sendCommand(tankId, deviceId, ops) {
  const mqttClient = await ensureClient();

  const tx_id = createTxId();
  const topic = `symbrosia/${SITE_ID}/${tankId}/${deviceId}/cmd`;
  const body = {
    tx_id,
    ts_utc: new Date().toISOString(),
    requested_by: "frontend",
    ops
  };

  const ackPromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(tx_id);
      reject(new Error("Command ACK timeout"));
    }, ACK_TIMEOUT_MS);

    pending.set(tx_id, { resolve, reject, timeoutId });
  });

  mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
    if (err) {
      const pendingEntry = pending.get(tx_id);
      if (pendingEntry) {
        clearTimeout(pendingEntry.timeoutId);
        pending.delete(tx_id);
        pendingEntry.reject(err);
      }
    }
  });

  return ackPromise;
}

/**
 * Convenience helper: send relay ON/OFF.
 * @param {string} tankId - e.g. "C15"
 * @param {1|2} relayNumber - 1 or 2
 * @param {0|1} value - 0=OFF, 1=ON
 */
export function sendRelayCommand(tankId, relayNumber, value) {
  if (relayNumber !== 1 && relayNumber !== 2) {
    return Promise.reject(new Error("relayNumber must be 1 or 2"));
  }
  const deviceId = `ctrl-${tankId}`;
  const point = relayNumber === 1 ? "relay1_request" : "relay2_request";

  return sendCommand(tankId, deviceId, [{ point, value }]);
}
