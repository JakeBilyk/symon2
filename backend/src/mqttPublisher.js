import mqtt from "mqtt";

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

export function publishTelemetry(client, payload) {
  const { site_id, tank_id, device_id } = payload;
  const topic = `symbrosia/${site_id}/${tank_id}/${device_id}/telemetry`;
  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) console.error("MQTT publish error:", err);
  });
}
