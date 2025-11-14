import React, { useEffect, useMemo, useRef, useState } from "react";
import mqtt from "mqtt";
import { fetchJson } from "../utils/api.js";

const TOPIC = "symbrosia/+/+/+/telemetry";

export default function Tanks() {
  const [telemetry, setTelemetry] = useState({});
  const [connected, setConnected] = useState(false);
  const [liveMap, setLiveMap] = useState({});
  const [liveError, setLiveError] = useState("");
  const liveMapRef = useRef({});

  useEffect(() => {
    liveMapRef.current = liveMap;
    setTelemetry((prev) => {
      const next = {};
      for (const [tankId, payload] of Object.entries(prev)) {
        if (!(liveMap?.[tankId] === false)) {
          next[tankId] = payload;
        }
      }
      return next;
    });
  }, [liveMap]);

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function loadLiveMap() {
      try {
        const data = await fetchJson("/api/live-tanks");
        if (cancelled) return;
        setLiveMap(data?.liveTanks || {});
        setLiveError("");
      } catch (e) {
        if (!cancelled) setLiveError(e.message || "Failed to load live tank filter");
      }
    }

    loadLiveMap();
    timer = setInterval(loadLiveMap, 60_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

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
        if (err) console.error("MQTT subscribe error", err.message);
      });
    };
    const handleReconnect = () => setConnected(false);
    const handleClose = () => setConnected(false);
    const handleError = (err) => console.error("MQTT error:", err.message);
    const handleMessage = (topic, buf) => {
      try {
        const payload = JSON.parse(buf.toString());
        const tankId = payload?.tank_id;
        if (!tankId) return;
        const parts = (topic || "").split("/");
        const topicDeviceId = parts[3];
        const deviceId = payload?.device_id || topicDeviceId || "";
        const normalizedDeviceId = typeof deviceId === "string" ? deviceId.toLowerCase() : "";
        if (!normalizedDeviceId.startsWith("ctrl-")) return;
        if (liveMapRef.current?.[tankId] === false) return;
        setTelemetry((prev) => ({ ...prev, [tankId]: payload }));
      } catch (e) {
        console.error("telemetry parse error:", e.message);
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

  const cards = useMemo(() => {
    const entries = Object.entries(telemetry).filter(([tankId]) => !(liveMap?.[tankId] === false));
    entries.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    return entries;
  }, [telemetry, liveMap]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Tanks</h1>
          <p className="page-subtitle">Live controller telemetry filtered by the current live tank list.</p>
        </div>
        <div className="connection-status">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span>{connected ? "MQTT connected" : "MQTT disconnected"}</span>
        </div>
      </header>

      {liveError && <div className="callout error">{liveError}</div>}

      {cards.length > 0 ? (
        <div className="cards-grid">
          {cards.map(([tankId, payload]) => {
            const phValue = payload?.s?.ph;
            const tempValue = payload?.s?.temp1_C;
            return (
              <article key={tankId} className="card">
                <header className="card-header">
                  <h3>{tankId}</h3>
                  <span className={`qc-pill ${payload?.qc?.status === "ok" ? "ok" : "fail"}`}>
                    {payload?.qc?.status ?? "—"}
                  </span>
                </header>

                <dl className="metric-list">
                  <Metric
                    label="pH"
                    value={formatNumber(phValue, 2)}
                    status={classifyPh(phValue)}
                  />
                  <Metric
                    label="Temp (°C)"
                    value={formatNumber(tempValue, 1)}
                    status={classifyTemperature(tempValue)}
                  />
                </dl>

                <footer className="card-meta">
                  <span title="Device ID">{payload?.device_id ?? "—"}</span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <p>Waiting for telemetry…</p>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, status }) {
  const classes = ["metric-value"];
  if (status) classes.push(status);
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd className={classes.join(" ")}>{value ?? "—"}</dd>
    </div>
  );
}

function formatNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : null;
}

function classifyTemperature(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 21) return "low";
  if (value > 26) return "high";
  return "";
}

function classifyPh(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 7.2) return "low";
  if (value > 8.2) return "high";
  return "";
}
