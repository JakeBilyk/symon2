// ---------------------------------------------------------
//  frontend/src/utils/api.js   (Pi Production Version)
// ---------------------------------------------------------

// Prefer backend URL from environment (.env.production)
const API_BASE =
  (import.meta.env?.VITE_API_BASE || "http://192.168.0.140:4000").replace(/\/+$/, "");

/**
 * Build a full API URL.
 * If the caller passes a full URL, return it unchanged.
 */
export function apiUrl(pathname = "") {
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const safe = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${API_BASE}${safe}`;
}

/**
 * Format readable error messages pulled from HTML bodies.
 */
function formatError(text, fallback) {
  const snippet = (text || "").trim();
  if (!snippet) return fallback;
  if (/^<!?doctype/i.test(snippet) || /^</.test(snippet)) return fallback;
  return snippet;
}

/**
 * Parse JSON or throw helpful error if backend returns HTML/error page.
 */
async function parseJson(res) {
  if (res.status === 204) return null;

  const contentType = res.headers.get("content-type") || "";
  const clone = res.clone();

  try {
    return await res.json();
  } catch (err) {
    let snippet = "";
    try {
      const text = await clone.text();
      snippet = text.trim().slice(0, 200);
    } catch (_) {}

    const msg = formatError(
      snippet,
      "Received an unexpected response from the server"
    );

    const error = new Error(msg);
    error.status = res.status;
    throw error;
  }
}

/**
 * Core request helper — ALWAYS hits the backend on port 4000.
 */
async function request(pathname, options = {}) {
  const url = apiUrl(pathname);

  const opts = { ...options };
  const headers = { ...(opts.headers || {}) };

  if (opts.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  opts.headers = headers;

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error("Unable to reach backend server");
  }

  if (!res.ok) {
    const text = await res.text();
    const msg = formatError(text, `Request failed (${res.status})`);
    const error = new Error(msg);
    error.status = res.status;
    throw error;
  }

  return parseJson(res);
}

/**
 * Public helper used everywhere by your React code.
 */
export async function fetchJson(pathname, options = {}) {
  return request(pathname, options);
}

// Export the final resolved base for debugging/UI
export const API_BASE_URL = API_BASE;
