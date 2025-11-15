import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";

const REFRESH_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export default function Tanks() {
  const [snapshots, setSnapshots] = useState({});
  const [liveMap, setLiveMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;
    let isFirstLoad = true;

    async function load() {
      if (isFirstLoad) {
        setLoading(true);
      }

      try {
        const [liveData, liveTanks] = await Promise.all([
          fetchJson("/api/live"),
          fetchJson("/api/live-tanks"),
        ]);
        if (cancelled) return;

        const payload = liveData && typeof liveData === "object" && !Array.isArray(liveData) ? liveData : {};
        setSnapshots(payload);
        setLiveMap(liveTanks?.liveTanks || {});
        setError("");
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load latest snapshots");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
        isFirstLoad = false;
      }
    }

    load();
    timer = setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const cards = useMemo(() => {
    const entries = Object.entries(snapshots || {});
    const hasFilter = Object.keys(liveMap || {}).length > 0;
    const filtered = entries.filter(([tankId]) => {
      if (!hasFilter) return true;
      return liveMap?.[tankId] !== false;
    });
    filtered.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    return filtered;
  }, [snapshots, liveMap]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Controllers</h1>
          <p className="page-subtitle">Latest cached pH and temperature for every enabled tank.</p>
        </div>
      </header>

      {error && <div className="callout error">{error}</div>}

      {loading ? (
        <div className="empty-state">
          <p>Loading cached telemetry…</p>
        </div>
      ) : cards.length > 0 ? (
        <div className="cards-grid">
          {cards.map(([tankId, snapshot]) => {
            const phValue = snapshot?.ph;
            const tempValue = snapshot?.temp1_C;
            const updatedIso = snapshot?.ts_utc;
            const qcLabel = typeof snapshot?.qc === "string" ? snapshot.qc.toUpperCase() : "—";
            const qcClass = snapshot?.qc === "ok" ? "ok" : snapshot?.qc === "fail" ? "fail" : "";
            const stale = isSnapshotStale(updatedIso);
            const timestampClasses = ["timestamp", stale ? "stale" : "fresh"];

            return (
              <article key={tankId} className="card">
                <header className="card-header">
                  <h3>{tankId}</h3>
                  <div className="pill-group">
                    <span className={["qc-pill", qcClass].filter(Boolean).join(" ")}>{qcLabel}</span>
                    {stale && <span className="qc-pill fail">STALE</span>}
                  </div>
                </header>

                <dl className="metric-list">
                  <Metric label="pH" value={formatNumber(phValue, 2)} status={classifyPh(phValue)} />
                  <Metric
                    label="Temp (°C)"
                    value={formatNumber(tempValue, 1)}
                    status={classifyTemperature(tempValue)}
                  />
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
          <p>No cached telemetry has been recorded yet.</p>
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
