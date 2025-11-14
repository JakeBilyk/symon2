import React, { useEffect, useMemo, useState } from "react";
import mqtt from "mqtt";

const TOPIC = "symbrosia/+/+/+/telemetry";
const PREFERRED_KEYS = [
  "ph",
  "temp1_C",
  "internal_temp_C",
  "co2_ppm",
  "dissolved_oxygen",
  "salinity",
  "humidity",
  "flow_rate",
];

export default function UtilControllers() {
  const [telemetry, setTelemetry] = useState({});
  const [connected, setConnected] = useState(false);

  const url = import.meta.env.VITE_MQTT_URL;
  const user = import.meta.env.VITE_MQTT_USER;
  const pass = import.meta.env.VITE_MQTT_PASS;

  const client = useMemo(() => {
    if (!url) return null;
    return mqtt.connect(url, {
      username: user || undefined,
      password: pass || undefined,
      keepalive: 30,
      reconnectPeriod: 2000,
    });
  }, [url, user, pass]);

  useEffect(() => {
    if (!client) return undefined;

    const handleConnect = () => {
      setConnected(true);
      client.subscribe(TOPIC, (err) => {
        if (err) console.error("Utility subscribe error", err.message);
      });
    };
    const handleReconnect = () => setConnected(false);
    const handleClose = () => setConnected(false);
    const handleError = (err) => console.error("MQTT error:", err.message);
    const handleMessage = (topic, buf) => {
      try {
        const payload = JSON.parse(buf.toString());
        if (!payload?.tank_id) return;
        const parts = (topic || "").split("/");
        const topicDeviceId = parts[3];
        const deviceId = payload?.device_id || topicDeviceId || "";
        const normalizedDeviceId = typeof deviceId === "string" ? deviceId.toLowerCase() : "";
        if (!normalizedDeviceId.startsWith("util-")) return;
        setTelemetry((prev) => ({ ...prev, [payload.tank_id]: payload }));
      } catch (e) {
        console.error("Utility telemetry parse error:", e.message);
      }
    };

    client.on("connect", handleConnect);
    client.on("reconnect", handleReconnect);
    client.on("close", handleClose);
    client.on("error", handleError);
    client.on("message", handleMessage);

    return () => {
      client.removeListener("connect", handleConnect);
      client.removeListener("reconnect", handleReconnect);
      client.removeListener("close", handleClose);
      client.removeListener("error", handleError);
      client.removeListener("message", handleMessage);
      client.end(true);
    };
  }, [client]);

  const cards = useMemo(
    () => Object.entries(telemetry).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
    [telemetry],
  );

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Utility Controllers</h1>
          <p className="page-subtitle">Live readings from utility controllers (CO₂, DO, pumps, etc.).</p>
        </div>
        <div className="connection-status">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span>{connected ? "MQTT connected" : "MQTT disconnected"}</span>
        </div>
      </header>

      {cards.length > 0 ? (
        <div className="cards-grid">
          {cards.map(([tankId, payload]) => {
            const metrics = pickMetrics(payload?.s || {});
            return (
              <article key={tankId} className="card">
                <header className="card-header">
                  <h3>{tankId}</h3>
                  <span className={`qc-pill ${payload?.qc?.status === "ok" ? "ok" : "fail"}`}>
                    {payload?.qc?.status ?? "—"}
                  </span>
                </header>

                <dl className="metric-list">
                  {metrics.map(({ key, label, value }) => (
                    <Metric key={key} label={label} value={value} />
                  ))}
                </dl>

                <footer className="card-meta">
                  <span>{payload?.device_id ?? "—"}</span>
                  <span>{payload?.ts_utc ? new Date(payload.ts_utc).toLocaleTimeString() : "—"}</span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <p>Waiting for utility telemetry…</p>
        </div>
      )}
    </section>
  );
}

function pickMetrics(sensorDict) {
  const entries = Object.entries(sensorDict || {});
  const prioritized = PREFERRED_KEYS
    .map((key) => {
      if (!(key in sensorDict)) return null;
      return { key, label: prettyLabel(key), value: formatForKey(key, sensorDict[key]) };
    })
    .filter(Boolean);

  if (prioritized.length > 0) return prioritized;

  return entries.slice(0, 5).map(([key, value]) => ({
    key,
    label: prettyLabel(key),
    value: formatForKey(key, value),
  }));
}

function prettyLabel(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\b(\w)/g, (m) => m.toUpperCase())
    .replace("Ph", "pH")
    .replace("Co2", "CO₂");
}

function formatForKey(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (key.toLowerCase().includes("temp")) return value.toFixed(1);
  if (key.toLowerCase() === "ph") return value.toFixed(2);
  return value.toFixed(2);
}

function Metric({ label, value }) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
