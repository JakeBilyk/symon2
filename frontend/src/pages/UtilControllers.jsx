import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";

const REFRESH_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

const PREFERRED_KEYS = [
  "ph",
  "temp1_C",
  "internal_temp_C",
  "co2_ppm",
  "dissolved_oxygen",
  "salinity",
  "humidity",
  "flow_rate"
];

const NON_SENSOR_KEYS = new Set(["family", "ip", "ts_utc", "qc"]);

export default function UtilControllers() {
  const [snapshots, setSnapshots] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function load(isInitial = false) {
      if (isInitial) setLoading(true);
      try {
        const liveData = await fetchJson("/api/live");
        if (cancelled) return;
        const payload =
          liveData && typeof liveData === "object" && !Array.isArray(liveData)
            ? liveData
            : {};
        setSnapshots(payload);
        setError("");
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load utility telemetry");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load(true);
    timer = setInterval(() => load(false), REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const cards = useMemo(() => {
    const entries = Object.entries(snapshots || {});

    const utilEntries = entries.filter(([, snapshot]) => {
      return snapshot?.family === "util";
    });

    utilEntries.sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    return utilEntries;
  }, [snapshots]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Utility Controllers</h1>
          <p className="page-subtitle">
            Live cached readings from utility controllers (CO₂, DO, pumps,
            etc.).
          </p>
        </div>
      </header>

      {error && <div className="callout error">{error}</div>}

      {loading ? (
        <div className="empty-state">
          <p>Loading utility telemetry…</p>
        </div>
      ) : cards.length > 0 ? (
        <div className="cards-grid cards-grid-dense">
          {cards.map(([tankId, snapshot]) => {
            const updatedIso = snapshot?.ts_utc;
            const qcLabel =
              typeof snapshot?.qc === "string"
                ? snapshot.qc.toUpperCase()
                : "—";
            const qcClass =
              snapshot?.qc === "ok"
                ? "ok"
                : snapshot?.qc === "fail"
                ? "fail"
                : "";
            const stale = isSnapshotStale(updatedIso);
            const timestampClasses = ["timestamp", stale ? "stale" : "fresh"];

            const metrics = pickMetrics(snapshot || {});

            return (
              <article key={tankId} className="card card-compact">
                <header className="card-header">
                  <h3>{tankId}</h3>
                  <div className="pill-group">
                    <span
                      className={["qc-pill", qcClass]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {qcLabel}
                    </span>
                    {stale && <span className="qc-pill fail">STALE</span>}
                  </div>
                </header>

                <dl className="metric-list">
                  {metrics.map(({ key, label, value }) => (
                    <Metric key={key} label={label} value={value} />
                  ))}
                </dl>

                <footer className="card-meta">
                  <span title="Controller IP">{snapshot?.ip || "—"}</span>
                  <span
                    className={timestampClasses.join(" ")}
                    title={formatExactTimestamp(updatedIso)}
                  >
                    {formatUpdatedAgo(updatedIso)}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <p>No utility telemetry has been recorded yet.</p>
        </div>
      )}
    </section>
  );
}

function pickMetrics(snapshot) {
  const sensorDict = {};
  for (const [k, v] of Object.entries(snapshot || {})) {
    if (NON_SENSOR_KEYS.has(k)) continue;
    sensorDict[k] = v;
  }

  const prioritized = PREFERRED_KEYS.map((key) => {
    if (!(key in sensorDict)) return null;
    return {
      key,
      label: prettyLabel(key),
      value: formatForKey(key, sensorDict[key])
    };
  }).filter(Boolean);

  if (prioritized.length > 0) return prioritized;

  const entries = Object.entries(sensorDict);
  return entries.slice(0, 5).map(([key, value]) => ({
    key,
    label: prettyLabel(key),
    value: formatForKey(key, value)
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
      <dd className="metric-value">{value}</dd>
    </div>
  );
}

function isSnapshotStale(isoString) {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > STALE_THRESHOLD_MS;
}

function formatUpdatedAgo(isoString) {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) return "—";

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return new Date(ts).toLocaleString();
}

function formatExactTimestamp(isoString) {
  const ts = Date.parse(isoString || "");
  if (!Number.isFinite(ts)) return "No recent data";
  return new Date(ts).toLocaleString();
}
