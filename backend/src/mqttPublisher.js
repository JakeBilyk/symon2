// backend/src/mqttPublisher.js
import mqtt from "mqtt";
import { logTelemetry } from "./loggingService.js";

export function createMqttClient(env) {
  const url = `mqtt://${env.MQTT_HOST || "localhost"}:${env.MQTT_PORT || 1883}`;
  const client = mqtt.connect(url, {
    username: env.MQTT_USER || undefined,
    password: env.MQTT_PASS || undefined,
    reconnectPeriod: 2000,
    keepalive: 30,
    clean: true
  });

  client.on("connect", () => console.log(`✅ MQTT connected → ${url}`));
  client.on("reconnect", () => console.log("… MQTT reconnecting …"));
  client.on("error", (e) => console.error("MQTT error:", e.message));
  client.on("close", () => console.log("MQTT connection closed"));

  return client;
}

/**
 * Publish telemetry to MQTT AND persist it to NDJSON logs.
 *
 * @param {import('mqtt').MqttClient} client
 * @param {object} payload  Telemetry payload
 * @param {string} family   Device family ("ctrl", "bmm", "util")
 */
export function publishTelemetry(client, payload, family) {
  const { site_id, tank_id, device_id } = payload;

  // 1) Publish to MQTT
  const topic = `symbrosia/${site_id}/${tank_id}/${device_id}/telemetry`;
  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) console.error("MQTT publish error:", err);
  });

  // 2) Persist to local logs (rate-limited, per-tank-per-day)
  try {
    logTelemetry(payload, family);
  } catch (e) {
    console.error("Telemetry logging failed:", e.message);
  }
}
