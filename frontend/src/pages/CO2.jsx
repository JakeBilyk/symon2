import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";

function todayHstYmd() {
  // crude but effective: take now, format as YYYY-MM-DD in Honolulu
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Honolulu" }); // en-CA => YYYY-MM-DD
  return fmt.format(new Date());
}

export default function CO2() {
  const [tankId, setTankId] = useState("");
  const [date, setDate] = useState(() => todayHstYmd());
  const [config, setConfig] = useState(null);
  const [lpm, setLpm] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [live, cfg] = await Promise.all([
          fetchJson("/api/live"),
          fetchJson("/api/co2/config"),
        ]);

        if (cancelled) return;

        const utilIds = Object.entries(live || {})
          .filter(([, snap]) => snap?.family === "util" || snap?.family === "ctrl")
          .map(([id]) => id)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        setConfig(cfg);
        const first = utilIds[0] || "";
        setTankId((prev) => prev || first);

        const initialLpm =
          (first && cfg?.perTank?.[first] != null ? cfg.perTank[first] : cfg?.defaultLpm) ?? 2.5;
        setLpm(String(initialLpm));
      } catch (e) {
        setError(e?.message || "Failed to load CO₂ config");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const parsedLpm = useMemo(() => {
    const n = Number(lpm);
    return Number.isFinite(n) ? n : NaN;
  }, [lpm]);

  async function saveLpm() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (!tankId) throw new Error("Select a device first");
      if (!Number.isFinite(parsedLpm) || parsedLpm <= 0) throw new Error("LPM must be a positive number");

      const next = {
        defaultLpm: Number(config?.defaultLpm ?? 2.5),
        perTank: { ...(config?.perTank || {}), [tankId]: parsedLpm },
      };

      const updated = await fetchJson("/api/co2/config", {
        method: "POST",
        body: JSON.stringify(next),
      });
      setConfig(updated);
      setSuccess("Saved LPM.");
    } catch (e) {
      setError(e?.message || "Failed to save LPM");
    } finally {
      setBusy(false);
    }
  }

  async function compute() {
    setBusy(true);
    setError("");
    setSuccess("");
    setResult(null);
    try {
      if (!tankId) throw new Error("Select a device first");
      if (!date) throw new Error("Select a date");

      // default: timer_seconds (your “on time” counter style)
      const params = new URLSearchParams({ tankId, date, field: "timer_seconds" });
      const res = await fetchJson(`/api/co2/daily?${params.toString()}`);
      setResult(res);
    } catch (e) {
      setError(e?.message || "Failed to compute CO₂ usage");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>CO₂</h1>
          <p className="page-subtitle">
            Daily CO₂ consumption estimated from valve “On Time” seconds × technician-entered LPM.
          </p>
        </div>
      </header>

      {error && <div className="callout error">{error}</div>}
      {success && <div className="callout success">{success}</div>}

      {loading ? (
        <div className="empty-state"><p>Loading…</p></div>
      ) : (
        <div className="card">
          <div className="controls">
            <label>
              Device
              <input value={tankId} onChange={(e) => setTankId(e.target.value)} placeholder="Carbonator / C01 / etc" />
            </label>

            <label>
              Date (HST)
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>

            <label>
              Average LPM
              <input type="number" step="0.1" value={lpm} onChange={(e) => setLpm(e.target.value)} />
            </label>

            <button className="btn secondary" type="button" onClick={saveLpm} disabled={busy}>
              {busy ? "Working…" : "Save LPM"}
            </button>

            <button className="btn" type="button" onClick={compute} disabled={busy || !tankId}>
              {busy ? "Working…" : "Compute"}
            </button>
          </div>

          {result ? (
            <div style={{ marginTop: 12 }}>
              <div className="callout">
                <div><strong>On time:</strong> {Number(result.minutesOn).toFixed(2)} minutes</div>
                <div><strong>LPM:</strong> {Number(result.lpm).toFixed(2)}</div>
                <div><strong>Estimated CO₂:</strong> {Number(result.liters).toFixed(2)} L/day</div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
