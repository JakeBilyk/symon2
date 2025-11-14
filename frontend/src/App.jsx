import React from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import Tanks from "./pages/Tanks.jsx";
import BmmDashboard from "./pages/BMM.jsx";
import UtilControllers from "./pages/UtilControllers.jsx";
import LiveTanks from "./pages/LiveTanks.jsx";
import History from "./pages/History.jsx";
import NotFound from "./pages/NotFound.jsx";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="top-bar">
          <div className="brand">Symbrosia Gateway</div>
          <nav className="nav-links">
            <NavLink to="/tanks" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              Tanks
            </NavLink>
            <NavLink to="/bmms" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              BMMs
            </NavLink>
            <NavLink to="/utility" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              Utility
            </NavLink>
            <NavLink to="/live-tanks" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              Live Tanks
            </NavLink>
            <NavLink to="/history" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              History
            </NavLink>
          </nav>
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/tanks" replace />} />
            <Route path="/tanks" element={<Tanks />} />
            <Route path="/bmms" element={<BmmDashboard />} />
            <Route path="/utility" element={<UtilControllers />} />
            <Route path="/live-tanks" element={<LiveTanks />} />
            <Route path="/history" element={<History />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
