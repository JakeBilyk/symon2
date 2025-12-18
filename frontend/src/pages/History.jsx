import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiUrl, fetchJson } from "../utils/api.js";

// Force Hawaiʻi time display (HST, no DST)
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Honolulu",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// For <input type="datetime-local"> value (always interpreted as local time)
function toLocalInputValue(date) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function prettyError(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

function normalizeId(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  return x.id || x.tankId || x.name || "";
}

export default function History() {
  const [devices, setDevices] = useState([]); // [{ id, family, label }]
  const [tankId, setTankId] = useState("");

  const [metric, setMetric] = useState("ph");

  const [end, setEnd] = useState(() => toLocalInputValue(new Date()));
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return toLocalInputValue(d);
  });

  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loading, setLoading] = useState(false);
  const [points, setPoints] = useState([]);
  const [error, setError] = useState("");

  const metricLabel = metric === "temp1_C" ? "Temperature (°C)" : "pH";

  // Load ctrl tank IDs + util IDs once
  useEffect(() => {
    (async () => {
      setLoadingDevices(true);
      setError("");
      try {
        const [tanksRes, liveRes] = await Promise.all([
          fetchJson("/api/tanks"),
          fetchJson("/api/live"),
        ]);

        // ctrl: from /api/tanks
        const ctrlIds = Array.isArray(tanksRes?.tanks)
          ? tanksRes.tanks.map(normalizeId).filter(Boolean)
          : [];

        // util: from /api/live (now seeded, so util always appears)
        const utilIds = Object.entries(liveRes || {})
          .filter(([, snap]) => snap?.family === "util")
          .map(([id]) => id)
          .filter(Boolean);

        const merged = [];

        for (const id of ctrlIds) {
          merged.push({ id, family: "ctrl", label: `${id} (ctrl)` });
        }
        for (const id of utilIds) {
          // avoid duplicates if any name overlaps
          if (ctrlIds.includes(id)) continue;
          merged.push({ id, family: "util", label: `${id} (util)` });
        }

        merged.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

        setDevices(merged);
        if (!tankId && merged.length) setTankId(merged[0].id);
      } catch (e) {
        setError(prettyError(e) || "Failed to load devices");
      } finally {
        setLoadingDevices(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chartData = useMemo(() => {
    return (points || [])
      .map((p) => ({
        iso: p.ts || p.ts_hst || p.t || p.time,
        value: p.value ?? p.v,
      }))
      .filter((p) => p.iso && typeof p.value === "number" && Number.isFinite(p.value));
  }, [points]);

  async function loadHistory() {
    setLoading(true);
    setError("");
    try {
      if (!tankId) throw new Error("Select a device first");

      const startDate = new Date(start);
      const endDate = new Date(end);

      if (Number.isNaN(startDate.valueOf())) throw new Error("Invalid start time");
      if (Number.isNaN(endDate.valueOf())) throw new Error("Invalid end time");
      if (startDate > endDate) throw new Error("Start must be before end");

      const params = new URLSearchParams({
        tankId,
        metric,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      const res = await fetchJson(`/api/logs?${params.toString()}`);
      setPoints(Array.isArray(res?.points) ? res.points : []);
    } catch (e) {
      setPoints([]);
      setError(prettyError(e) || "Failed to load history");
    } finally {
      setLoading(false);
    }
  }

  async function downloadLatestLog() {
    setError("");
    try {
      if (!tankId) throw new Error("Select a device first");

      const res = await fetchJson(
        `/api/log-files?tankId=${encodeURIComponent(tankId)}&limit=1`
      );
      const latest = Array.isArray(res?.files) ? res.files[0] : null;
      if (!latest?.name) throw new Error("No log files found for this device");

      const url = apiUrl(
        `/api/log-files/download?tankId=${encodeURIComponent(
          tankId
        )}&file=${encodeURIComponent(latest.name)}`
      );

      window.location.href = url;
    } catch (e) {
      setError(prettyError(e) || "Failed to download log");
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>History</h1>
          <p className="page-subtitle">
            Plot logged pH or temperature for a selected controller (tank or utility). Times shown in Hawaiʻi (HST).
          </p>
        </div>
      </header>

      <div className="card">
        <div className="controls">
          <label>
            Device
            <select
              value={tankId}
              onChange={(e) => setTankId(e.target.value)}
              disabled={loadingDevices}
            >
              <option value="" disabled>
                {loadingDevices ? "Loading..." : "Select a device"}
              </option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Metric
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              <option value="ph">pH</option>
              <option value="temp1_C">Temperature (°C)</option>
            </select>
          </label>

          <label>
            Start (HST)
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>

          <label>
            End (HST)
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>

          <button className="btn" onClick={loadHistory} disabled={loading || !tankId}>
            {loading ? "Loading…" : "Plot"}
          </button>

          <button
            className="btn secondary"
            type="button"
            onClick={downloadLatestLog}
            disabled={!tankId}
            title="Downloads the most recent NDJSON log file for this controller"
          >
            Download latest log
          </button>
        </div>

        {error ? (
          <div className="error">
            <strong>Error:</strong> {error}
          </div>
        ) : null}

        <div className="chart-area">
          {loading ? (
            <div className="empty-state">
              <p>Loading…</p>
            </div>
          ) : chartData.length ? (
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="iso"
                  tickFormatter={(iso) => formatter.format(new Date(iso))}
                  minTickGap={30}
                />
                <YAxis
                  domain={metric === "ph" ? [0, 14] : ["auto", "auto"]}
                  tickFormatter={(v) => (typeof v === "number" ? v.toString() : "")}
                />
                <Tooltip
                  labelFormatter={(iso) => formatter.format(new Date(iso))}
                  formatter={(value) => [value, metricLabel]}
                />
                <Line type="monotone" dataKey="value" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">
              <p>No log points found for the selected range.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
