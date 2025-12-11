// src/pages/Settings.jsx
import React, { useEffect, useState, useMemo } from "react";
import { fetchJson } from "../utils/api.js";

export default function Settings() {
  const [phLow, setPhLow] = useState("");
  const [phHigh, setPhHigh] = useState("");
  const [tempLow, setTempLow] = useState("");
  const [tempHigh, setTempHigh] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Load current thresholds from backend
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      setSuccess("");

      try {
        const data = await fetchJson("/api/alarm-thresholds");
        // Expecting shape: { ph: { low, high }, temp: { low, high } }
        const ph = data?.ph || {};
        const temp = data?.temp || {};

        if (!cancelled) {
          setPhLow(ph.low != null ? String(ph.low) : "");
          setPhHigh(ph.high != null ? String(ph.high) : "");
          setTempLow(temp.low != null ? String(temp.low) : "");
          setTempHigh(temp.high != null ? String(temp.high) : "");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || "Failed to load alarm thresholds");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Parse values + basic validation
  const { parsed, isValid, validationMessage } = useMemo(() => {
    const result = {
      phLowNum: parseFloat(phLow),
      phHighNum: parseFloat(phHigh),
      tempLowNum: parseFloat(tempLow),
      tempHighNum: parseFloat(tempHigh),
    };

    // All must be finite numbers
    for (const key of Object.keys(result)) {
      if (!Number.isFinite(result[key])) {
        return {
          parsed: null,
          isValid: false,
          validationMessage: "All thresholds must be valid numbers.",
        };
      }
    }

    if (result.phLowNum >= result.phHighNum) {
      return {
        parsed: result,
        isValid: false,
        validationMessage: "pH low threshold must be less than pH high threshold.",
      };
    }

    if (result.tempLowNum >= result.tempHighNum) {
      return {
        parsed: result,
        isValid: false,
        validationMessage:
          "Temperature low threshold must be less than temperature high threshold.",
      };
    }

    return {
      parsed: result,
      isValid: true,
      validationMessage: "",
    };
  }, [phLow, phHigh, tempLow, tempHigh]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isValid || !parsed) return;

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      await fetchJson("/api/alarm-thresholds", {
        method: "POST",
        body: JSON.stringify({
          ph: {
            low: parsed.phLowNum,
            high: parsed.phHighNum,
          },
          temp: {
            low: parsed.tempLowNum,
            high: parsed.tempHighNum,
          },
        }),
      });

      setSuccess("Alarm thresholds saved.");
    } catch (e) {
      setError(e?.message || "Failed to save alarm thresholds");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Alarm Settings</h1>
          <p className="page-subtitle">
            Adjust pH and temperature thresholds used for controller alarms. Changes
            take effect on the next polling cycles.
          </p>
        </div>
      </header>

      {error && <div className="callout error">{error}</div>}
      {success && <div className="callout success">{success}</div>}
      {validationMessage && !error && (
        <div className="callout error">{validationMessage}</div>
      )}

      {loading ? (
        <div className="empty-state">
          <p>Loading current alarm settings…</p>
        </div>
      ) : (
        <form className="history-form" onSubmit={handleSubmit}>
          <label>
            <span>pH low threshold</span>
            <input
              type="number"
              step="0.01"
              value={phLow}
              onChange={(e) => setPhLow(e.target.value)}
            />
          </label>

          <label>
            <span>pH high threshold</span>
            <input
              type="number"
              step="0.01"
              value={phHigh}
              onChange={(e) => setPhHigh(e.target.value)}
            />
          </label>

          <label>
            <span>Temperature low (°C)</span>
            <input
              type="number"
              step="0.1"
              value={tempLow}
              onChange={(e) => setTempLow(e.target.value)}
            />
          </label>

          <label>
            <span>Temperature high (°C)</span>
            <input
              type="number"
              step="0.1"
              value={tempHigh}
              onChange={(e) => setTempHigh(e.target.value)}
            />
          </label>

          <button
            type="submit"
            className="primary"
            disabled={saving || !isValid}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </form>
      )}
    </section>
  );
}
