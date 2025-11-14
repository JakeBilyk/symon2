import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../utils/api.js";

export default function LiveTanks() {
  const [tanks, setTanks] = useState([]);
  const [liveMap, setLiveMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await fetchJson("/api/tanks");
        if (cancelled) return;
        setTanks(data?.tanks || []);
        setLiveMap(data?.liveTanks || {});
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load tank list");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const displayTanks = useMemo(() => tanks, [tanks]);

  const handleToggle = (tank) => {
    setLiveMap((prev) => {
      const active = !(prev?.[tank] === false);
      return { ...prev, [tank]: !active };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const payload = displayTanks.reduce((acc, tank) => {
        acc[tank] = !(liveMap?.[tank] === false);
        return acc;
      }, {});
      await fetchJson("/api/live-tanks", {
        method: "POST",
        body: JSON.stringify({ liveTanks: payload }),
      });
      setMessage(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setError(e.message || "Failed to save live tanks");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Live Tank Filter</h1>
          <p className="page-subtitle">
            Enable or disable tanks. Controllers marked off are skipped by the gateway poller.
          </p>
        </div>
      </header>

      {loading ? (
        <div className="empty-state">
          <p>Loading tanks…</p>
        </div>
      ) : (
        <>
          {error && <div className="callout error">{error}</div>}
          {message && <div className="callout success">{message}</div>}

          <div className="checkbox-grid">
            {displayTanks.map((tank) => {
              const checked = !(liveMap?.[tank] === false);
              return (
                <label key={tank} className="checkbox-card">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggle(tank)}
                  />
                  <span>{tank}</span>
                </label>
              );
            })}
            {displayTanks.length === 0 && <p>No tanks found.</p>}
          </div>

          <div className="actions">
            <button type="button" className="primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
