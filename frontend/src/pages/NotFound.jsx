import React from "react";
import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Page not found</h1>
          <p className="page-subtitle">The page you were looking for does not exist.</p>
        </div>
      </header>
      <div className="empty-state">
        <p>
          Return to the <Link to="/tanks">Tanks dashboard</Link>.
        </p>
      </div>
    </section>
  );
}
