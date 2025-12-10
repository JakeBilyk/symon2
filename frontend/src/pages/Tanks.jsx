// src/pages/Tanks.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";
import { sendRelayCommand } from "../utils/sendCommand.js";
import ConfirmModal from "../components/ConfirmModal.jsx";

const REFRESH_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export default function Tanks() {
  const [snapshots, setSnapshots] = useState({});
  const [liveMap, setLiveMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [confirmState, setConfirmState] = useState({
    open: false,
    tankId: null,
    relayNumber: null,
    value: null
  });
  const [commandBusy, setCommandBusy] = useState(false);

  // Shared loader so we can call it from both the poller and after commands
  const loadSnapshots = useCallback(
    async (isInitial = false) => {
      if (isInitial) {
        setLoading(true);
      }

      try {
        const [liveData, liveTanks] = await Promise.all([
          fetchJson("/api/live"),
          fetchJson("/api/live-tanks")
        ]);

        const payload =
          liveData && typeof liveData === "object" && !Array.isArray(liveData)
            ? liveData
            : {};

        setSnapshots(payload);
        setLiveMap(liveTanks?.liveTanks || {});
        setError("");
      } catch (e) {
        setError(e?.message || "Failed to load latest snapshots");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    let timer;

    async function initialLoad() {
      if (cancelled) return;
      await loadSnapshots(true);
      if (cancelled) return;
      timer = setInterval(() => {
        loadSnapshots(false).catch(() => {});
      }, REFRESH_INTERVAL_MS);
    }

    initialLoad().catch(() => {});

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [loadSnapshots]);

  const cards = useMemo(() => {
  const entries = Object.entries(snapshots || {});

  // Only keep controller family on this page
  const ctrlEntries = entries.filter(([, snapshot]) => {
    const fam = snapshot?.family;
    // Treat missing family as ctrl just in case
    return fam === "ctrl" || fam === undefined || fam === null;
  });

  const hasFilter = Object.keys(liveMap || {}).length > 0;
  const filtered = ctrlEntries.filter(([tankId]) => {
    if (!hasFilter) return true;
    return liveMap?.[tankId] !== false;
  });

  filtered.sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  return filtered;
}, [snapshots, liveMap]);


  const openRelayConfirm = (tankId, relayNumber, value) => {
    setConfirmState({
      open: true,
      tankId,
      relayNumber,
      value
    });
  };

  const closeConfirm = () => {
    if (commandBusy) return;
    setConfirmState({
      open: false,
      tankId: null,
      relayNumber: null,
      value: null
    });
  };

  const handleConfirm = async () => {
    const { tankId, relayNumber, value } = confirmState;
    if (!tankId || !relayNumber || value === null) {
      closeConfirm();
      return;
    }

    setCommandBusy(true);
    try {
      await sendRelayCommand(tankId, relayNumber, value);
      // After a successful command, refresh snapshots
      await loadSnapshots(false);
    } catch (e) {
      setError(e?.message || "Failed to send relay command");
    } finally {
      setCommandBusy(false);
      closeConfirm();
    }
  };

  const confirmMessage =
    confirmState.open && confirmState.tankId
      ? `Set Relay ${confirmState.relayNumber} on tank ${confirmState.tankId} to ${
          confirmState.value === 1 ? "ON" : "OFF"
        }?`
      : "";

  return (
    <>
      <section className="page">
        <header className="page-header">
          <div>
            <h1>Controllers</h1>
            <p className="page-subtitle">
              Latest cached pH and temperature for every enabled tank, with
              relay controls.
            </p>
          </div>
        </header>

        {error && <div className="callout error">{error}</div>}

        {loading ? (
          <div className="empty-state">
            <p>Loading cached telemetry…</p>
          </div>
        ) : cards.length > 0 ? (
          <div className="cards-grid cards-grid-dense">
            {cards.map(([tankId, snapshot]) => {
              const phValue = snapshot?.ph;
              const tempValue = snapshot?.temp1_C;
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

              const relay1Status = snapshot?.relay1_status;
              const relay2Status = snapshot?.relay2_status;

              const relay1Label =
                relay1Status === 1
                  ? "ON"
                  : relay1Status === 0
                  ? "OFF"
                  : "—";
              const relay2Label =
                relay2Status === 1
                  ? "ON"
                  : relay2Status === 0
                  ? "OFF"
                  : "—";

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
                    <Metric label="Relay 1" value={relay1Label} />
                    <Metric label="Relay 2" value={relay2Label} />
                  </dl>

                  <div className="relay-controls">
                    <div className="relay-row">
                      <span className="relay-label">Relay 1:</span>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={commandBusy}
                        onClick={() => openRelayConfirm(tankId, 1, 1)}
                      >
                        ON
                      </button>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={commandBusy}
                        onClick={() => openRelayConfirm(tankId, 1, 0)}
                      >
                        OFF
                      </button>
                    </div>
                    <div className="relay-row">
                      <span className="relay-label">Relay 2:</span>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={commandBusy}
                        onClick={() => openRelayConfirm(tankId, 2, 1)}
                      >
                        ON
                      </button>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={commandBusy}
                        onClick={() => openRelayConfirm(tankId, 2, 0)}
                      >
                        OFF
                      </button>
                    </div>
                  </div>

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

      <ConfirmModal
        open={confirmState.open}
        title="Confirm Relay Change"
        message={confirmMessage}
        onConfirm={handleConfirm}
        onCancel={closeConfirm}
        busy={commandBusy}
        confirmLabel="Apply"
      />
    </>
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
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : null;
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
