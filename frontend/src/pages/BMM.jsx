import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";

const REFRESH_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export default function BmmDashboard() {
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
        setError(e?.message || "Failed to load BMM snapshots");
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

    const bmmEntries = entries.filter(([, snapshot]) => {
      return snapshot?.family === "bmm";
    });

    bmmEntries.sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    return bmmEntries;
  }, [snapshots]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>BMMs</h1>
          <p className="page-subtitle">
            Live cached snapshots from biomass monitors.
          </p>
        </div>
      </header>

      {error && <div className="callout error">{error}</div>}

      {loading ? (
        <div className="empty-state">
          <p>Loading BMM telemetry…</p>
        </div>
      ) : cards.length > 0 ? (
        <div className="cards-grid cards-grid-dense">
          {cards.map(([tankId, snapshot]) => {
            const biomass = snapshot?.biomass;
            const chClear = snapshot?.ch_clear;
            const signal = snapshot?.signal_strength;
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
                  <Metric label="Biomass" value={formatNumber(biomass, 2)} />
                  <Metric label="Ch Clear" value={formatNumber(chClear, 2)} />
                  <Metric
                    label="Signal"
                    value={formatNumber(signal, 1) ?? "—"}
                  />
                </dl>

                <footer className="card-meta">
                  <span title="Device IP">{snapshot?.ip || "—"}</span>
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
          <p>No BMM telemetry has been recorded yet.</p>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd className="metric-value">{value ?? "—"}</dd>
    </div>
  );
}

function formatNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : null;
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
