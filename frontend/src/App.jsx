// src/App.jsx
import React from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";

import Tanks from "./pages/Tanks.jsx";
import BmmDashboard from "./pages/BMM.jsx";
import UtilControllers from "./pages/UtilControllers.jsx";
import LiveTanks from "./pages/LiveTanks.jsx";
import History from "./pages/History.jsx";
import CO2 from "./pages/CO2.jsx";
import Settings from "./pages/Settings.jsx";
import NotFound from "./pages/NotFound.jsx";

import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="top-bar">
          <div className="brand">Symbrosia Gateway</div>

          <nav className="nav-links">
            <NavItem to="/tanks" label="Tanks" />
            <NavItem to="/bmms" label="BMMs" />
            <NavItem to="/utility" label="Utility" />
            <NavItem to="/history" label="History" />
            <NavItem to="/co2" label="CO₂" />
            <NavItem to="/live-tanks" label="Live Tanks" />
            <NavItem to="/settings" label="Settings" />
          </nav>
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/tanks" replace />} />
            <Route path="/tanks" element={<Tanks />} />
            <Route path="/bmms" element={<BmmDashboard />} />
            <Route path="/utility" element={<UtilControllers />} />
            <Route path="/history" element={<History />} />
            <Route path="/co2" element={<CO2 />} />
            <Route path="/live-tanks" element={<LiveTanks />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function NavItem({ to, label }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
    >
      {label}
    </NavLink>
  );
}
