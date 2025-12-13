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
import { fetchJson } from "../utils/api.js";

// Force Hawaiʻi time display (HST, no DST)
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Honolulu",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// For <input type="datetime-local"> value (always interpreted as local time)
// Since you said "assume we’re always in Hawaiʻi", this is exactly HST in practice.
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

export default function History() {
  const [tanks, setTanks] = useState([]);
  const [tankId, setTankId] = useState("");

  // Use the actual logged field name now
  const [metric, setMetric] = useState("ph");

  // Default window: last 24 hours (Hawaiʻi local time)
  const [end, setEnd] = useState(() => toLocalInputValue(new Date()));
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return toLocalInputValue(d);
  });

  const [loadingTanks, setLoadingTanks] = useState(false);
  const [loading, setLoading] = useState(false);
  const [points, setPoints] = useState([]);
  const [error, setError] = useState("");

  const metricLabel = metric === "temp1_C" ? "Temperature (°C)" : "pH";

  // Load tanks once
  useEffect(() => {
    (async () => {
      setLoadingTanks(true);
      setError("");
      try {
        const res = await fetchJson("/api/tanks");
        const list = Array.isArray(res?.tanks) ? res.tanks : [];
        setTanks(list);
        if (!tankId && list.length) setTankId(list[0].id || list[0].tankId || list[0]);
      } catch (e) {
        setError(prettyError(e) || "Failed to load tanks");
      } finally {
        setLoadingTanks(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chartData = useMemo(() => {
    // Accept backend points as {ts,value} OR {ts_hst,value}
    // (we normalize to {iso,value})
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
      if (!tankId) throw new Error("Select a tank first");

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

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Tank History</h1>
          <p className="page-subtitle">
            Plot logged pH or temperature for a selected tank. Times shown in Hawaiʻi (HST).
          </p>
        </div>
      </header>

      <div className="card">
        <div className="controls">
          <label>
            Tank
            <select
              value={tankId}
              onChange={(e) => setTankId(e.target.value)}
              disabled={loadingTanks}
            >
              <option value="" disabled>
                {loadingTanks ? "Loading..." : "Select a tank"}
              </option>
              {tanks.map((t) => {
                const id = t.id || t.tankId || t;
                const name = t.name || id;
                return (
                  <option key={id} value={id}>
                    {name}
                  </option>
                );
              })}
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
