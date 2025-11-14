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

const formatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function toLocalInputValue(date) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function History() {
  const [tanks, setTanks] = useState([]);
  const [tankId, setTankId] = useState("");
  const [metric, setMetric] = useState("ph");
  const [start, setStart] = useState(() => {
    const end = new Date();
    const startDate = new Date(end.getTime() - 6 * 60 * 60 * 1000);
    return toLocalInputValue(startDate);
  });
  const [end, setEnd] = useState(() => toLocalInputValue(new Date()));
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadTanks() {
      try {
        const data = await fetchJson("/api/tanks");
        if (cancelled) return;
        setTanks(data?.tanks || []);
        if (data?.tanks?.length) {
          setTankId((prev) => prev || data.tanks[0]);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load tanks");
      }
    }
    loadTanks();
    return () => {
      cancelled = true;
    };
  }, []);

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        iso: p.ts,
        value: p.value,
      })),
    [points],
  );

  const submitDisabled = !tankId || loading;

  const loadHistory = async () => {
    if (!tankId) {
      setError("Select a tank to plot history");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (!(startDate instanceof Date) || Number.isNaN(startDate.valueOf())) {
        throw new Error("Invalid start time");
      }
      if (!(endDate instanceof Date) || Number.isNaN(endDate.valueOf())) {
        throw new Error("Invalid end time");
      }
      if (startDate > endDate) {
        throw new Error("Start must be before end");
      }

      const params = new URLSearchParams({
        tankId,
        metric,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });
      const data = await fetchJson(`/api/logs?${params.toString()}`);
      setPoints(data?.points || []);
    } catch (e) {
      setError(e.message || "Failed to load history");
      setPoints([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tankId) {
      loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tankId]);

  const metricLabel = metric === "temp" ? "Temperature (°C)" : "pH";

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Tank History</h1>
          <p className="page-subtitle">Plot logged pH or temperature readings for a selected tank.</p>
        </div>
      </header>

      <form
        className="history-form"
        onSubmit={(e) => {
          e.preventDefault();
          loadHistory();
        }}
      >
        <label>
          Tank
          <select value={tankId} onChange={(e) => setTankId(e.target.value)}>
            {tanks.map((tank) => (
              <option key={tank} value={tank}>
                {tank}
              </option>
            ))}
          </select>
        </label>

        <label>
          Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="ph">pH</option>
            <option value="temp">Temperature (°C)</option>
          </select>
        </label>

        <label>
          Start
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>

        <label>
          End
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>

        <button type="submit" className="primary" disabled={submitDisabled}>
          {loading ? "Loading…" : "Plot"}
        </button>
      </form>

      {error && <div className="callout error">{error}</div>}

      <div className="chart-panel">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={chartData} margin={{ top: 16, right: 24, left: 0, bottom: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.1)" />
              <XAxis
                dataKey="iso"
                tickFormatter={(iso) => formatter.format(new Date(iso))}
                minTickGap={24}
              />
              <YAxis
                width={80}
                domain={["auto", "auto"]}
                label={{ value: metricLabel, angle: -90, position: "insideLeft" }}
              />
              <Tooltip
                labelFormatter={(iso) => formatter.format(new Date(iso))}
                formatter={(value) => [value, metricLabel]}
              />
              <Line type="monotone" dataKey="value" stroke="#db0f40" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">
            <p>No log points found for the selected range.</p>
          </div>
        )}
      </div>
    </section>
  );
}
