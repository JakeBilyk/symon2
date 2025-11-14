// frontend/src/utils/api.js

const envBase = (import.meta.env?.VITE_API_BASE_URL || "").trim();
const normalizedEnvBase = envBase ? envBase.replace(/\/+$/, "") : "";

/**
 * Dev ports that usually host the frontend; when detected, we try a backend fallback port.
 * Adjust as needed.
 */
const DEV_PORT_FALLBACKS = new Set(["5173", "5174", "4173", "4174", "3000", "3001"]);
const FALLBACK_PORT = "4000";

/** Keep a cached base so we don't re-probe on every call. */
let cachedBase = normalizedEnvBase || "";

/** Exported so other modules can read the current base URL (kept in sync with cachedBase). */
export let API_BASE_URL = cachedBase;

/* ------------------------- helpers ------------------------- */

function sanitizeBase(base) {
  if (!base) return "";
  return base.replace(/\/+$/, "");
}

function buildOrigin(protocol, hostname, port) {
  if (!protocol || !hostname) return "";
  const suffix = port ? `:${port}` : "";
  return `${protocol}//${hostname}${suffix}`;
}

function inferBaseFromLocation() {
  if (typeof window === "undefined") return "";
  const origin = window.location?.origin;
  return origin ? origin.replace(/\/+$/, "") : "";
}

function inferBaseCandidates() {
  const candidates = [];

  // 1) Explicit env first.
  if (normalizedEnvBase) {
    candidates.push(normalizedEnvBase);
  }

  // 2) Window origin (when running in the browser).
  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location || {};
    const origin = sanitizeBase(buildOrigin(protocol, hostname, port));
    if (origin) {
      candidates.push(origin);
    }

    // 3) If we're on a dev port, also try a likely backend fallback port.
    const shouldTryFallbackPort = !port || DEV_PORT_FALLBACKS.has(port);
    if (shouldTryFallbackPort && protocol && hostname) {
      const fallback = sanitizeBase(buildOrigin(protocol, hostname, FALLBACK_PORT));
      if (fallback && fallback !== origin) {
        candidates.push(fallback);
      }
    }
  }

  // 4) Finally, allow "relative" requests (empty base) as a last resort.
  candidates.push("");

  // Dedup while preserving order.
  const seen = new Set();
  return candidates.filter((base) => {
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

/* ------------------------- public URL builder ------------------------- */

/**
 * Builds a URL using the best-known base. If a full URL is provided, returns it unchanged.
 * Kept compatible with main: callers can keep using apiUrl(pathname).
 * Advanced callers may pass a baseOverride to force a base (optional).
 */
export function apiUrl(pathname = "", baseOverride = cachedBase) {
  if (/^https?:\/\//i.test(pathname)) {
    return pathname;
  }
  const safePath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const base = sanitizeBase(baseOverride);
  if (!base) return safePath;
  return `${base}${safePath}`;
}

/* ------------------------- fetch utilities ------------------------- */

function shouldRetry(method) {
  const upper = (method || "GET").toUpperCase();
  // Only idempotent methods by default
  return upper === "GET" || upper === "HEAD";
}

function markRetryable(error, retryable) {
  if (error && typeof error === "object") {
    Object.defineProperty(error, "retryable", {
      value: retryable,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

function formatErrorMessage(text, fallback) {
  const snippet = (text || "").trim();
  if (!snippet) return fallback;
  if (/^<!?doctype/i.test(snippet) || /^</.test(snippet)) {
    return fallback;
  }
  return snippet;
}

async function parseJsonResponse(res) {
  if (res.status === 204) return null;

  const contentType = res.headers.get("content-type") || "";
  const lowerType = contentType.toLowerCase();
  const clone = res.clone();

  try {
    if (!lowerType.includes("json")) {
      // Try to parse anyway; many callers expect JSON
      const data = await res.json();
      return data;
    }
    return await res.json();
  } catch (err) {
    let snippet = "";
    try {
      const text = await clone.text();
      snippet = text.trim().slice(0, 200);
    } catch (_) {
      // ignore secondary errors
    }
    const looksHtml = lowerType.includes("text/html") || /^<!/i.test(snippet);
    const message = formatErrorMessage(
      snippet,
      looksHtml ? "Received an unexpected response from the server" : err?.message || "Invalid JSON response",
    );
    const error = new Error(message);
    if (err) error.cause = err;
    throw markRetryable(error, looksHtml);
  }
}

async function request(pathname, options, base) {
  const finalOptions = { ...options };
  const headers = { ...(options?.headers || {}) };

  if (finalOptions.body !== undefined && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }
  if (Object.keys(headers).length > 0) {
    finalOptions.headers = headers;
  }

  const url = apiUrl(pathname, base);

  try {
    const res = await fetch(url, finalOptions);
    if (!res.ok) {
      const text = await res.text();
      const message = formatErrorMessage(text, res.statusText || `Request failed (${res.status})`);
      const error = new Error(message);
      error.status = res.status;
      const retriableStatus = res.status === 404 || res.status === 405 || res.status >= 500;
      throw markRetryable(error, retriableStatus);
    }
    return await parseJsonResponse(res);
  } catch (err) {
    // Network/type errors (e.g., CORS, DNS) are often transient.
    throw markRetryable(err, err?.retryable ?? err?.name === "TypeError");
  }
}

/**
 * Public fetch helper (API-compatible with main).
 * Tries env → window.origin → backend fallback port → relative, caching on first success.
 */
export async function fetchJson(pathname, options = {}) {
  // Initialize candidates (prefer cachedBase if we already learned one)
  const candidates = cachedBase ? [cachedBase] : inferBaseCandidates();
  const allowRetry = shouldRetry(options.method);
  let lastError;

  for (let i = 0; i < candidates.length; i += 1) {
    const base = candidates[i];
    try {
      const data = await request(pathname, options, base);
      // Update caches and exported variable for downstream readers.
      cachedBase = base;
      API_BASE_URL = cachedBase;
      return data;
    } catch (err) {
      lastError = err;
      const canRetry = allowRetry || err?.retryable;
      if (!canRetry || i === candidates.length - 1) break;
      // try next candidate
    }
  }

  throw new Error(lastError?.message || "Network request failed");
}

/* Initialize cache from location if none provided via env */
if (!cachedBase) {
  const loc = inferBaseFromLocation();
  if (loc) {
    cachedBase = loc;
    API_BASE_URL = loc;
  }
}
