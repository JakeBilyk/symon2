import React, { useEffect, useMemo, useState } from "react";
import mqtt from "mqtt";

const TOPIC = "symbrosia/+/+/+/telemetry";

export default function BmmDashboard() {
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
        if (err) console.error("BMM subscribe error", err.message);
      });
    };
    const handleReconnect = () => setConnected(false);
    const handleClose = () => setConnected(false);
    const handleError = (err) => console.error("MQTT error:", err.message);
    const handleMessage = (topic, buf) => {
      try {
        const payload = JSON.parse(buf.toString());
        if (!payload?.tank_id) return;
        const parts = topic.split("/");
        const device = parts[3];
        if (!device || !device.startsWith("bmm-")) return;
        setTelemetry((prev) => ({ ...prev, [payload.tank_id]: payload }));
      } catch (e) {
        console.error("BMM telemetry parse error:", e.message);
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
          <h1>BMMs</h1>
          <p className="page-subtitle">Biomass monitor snapshots with live MQTT telemetry.</p>
        </div>
        <div className="connection-status">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span>{connected ? "MQTT connected" : "MQTT disconnected"}</span>
        </div>
      </header>

      {cards.length > 0 ? (
        <div className="cards-grid">
          {cards.map(([tankId, payload]) => (
            <article key={tankId} className="card">
              <header className="card-header">
                <h3>{tankId}</h3>
              </header>

              <dl className="metric-list">
                <Metric label="Biomass" value={formatNumber(payload?.biomass, 2)} />
                <Metric label="Ch Clear" value={formatNumber(payload?.ch_clear, 1)} />
                <Metric label="Signal" value={formatNumber(payload?.signal_strength, 1)} />
              </dl>

              <footer className="card-meta">
                <span>{payload?.device_id ?? "—"}</span>
                <span>{payload?.ts_utc ? new Date(payload.ts_utc).toLocaleTimeString() : "—"}</span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p>Waiting for BMM telemetry…</p>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

function formatNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : null;
}
