// Dashboard support helpers (docs/plans/queue-dashboard.md): CSRF origin
// check, fixed response header sets, opaque keyset-pagination cursors, and
// the HTML template filler. No env/sql/BridgeDO ownership. Depends only on
// worker-http.js's generic base64url codecs — never imports index.js (see
// CLAUDE.md's "index.js -> domain -> pure helpers" dependency direction).

import { base64UrlEncode, base64UrlDecode } from "./worker-http.js";

/** Strict same-origin check for dashboard mutations (§"状態変更 API の CSRF
 *  対策"). Deliberately not the existing checkOrigin(): that one treats a
 *  missing Origin header as "allow" (fine for server-to-server callers with
 *  no ambient credential — see its own comment), but the dashboard's
 *  session cookie *is* ambient browser-sent authority, so a missing Origin
 *  here must fail closed instead. */
function checkDashboardOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function dashboardHtmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    // script-src 'self' (not the OAuth consent page's script-less CSP,
    // which can't run the dashboard's polling/kanban JS) — see
    // Dashboard scripts and styles are fixed same-origin Text modules.
    "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function dashboardJsHeaders() {
  return { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

function dashboardCssHeaders() {
  return { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

function dashboardApiHeaders() {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

/** Opaque keyset-pagination cursor (§"pagination の API 契約", U4): encodes
 *  the (timestamp, tie-breaker id) of the last row on a page. Callers pass it
 *  straight back; nothing outside this file interprets its contents. */
function encodeDashboardCursor(t, id) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify({ t, id })));
}

function decodeDashboardCursor(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(raw)));
    if (!parsed || !Number.isFinite(parsed.t) || typeof parsed.id !== "string" || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Fills a dashboard HTML Text-module template's `{{MARKER}}` placeholders.
// Uses split/join (never String#replace with a pattern string) so a `$`
// inside a value (e.g. `$&`) can never be reinterpreted as a replacement
// pattern. Throws if any `{{`/`}}` marker syntax remains unresolved, so a
// mistyped/missing marker can never reach the browser silently.
function fillDashboardTemplate(template, values) {
  let out = template;
  for (const [marker, value] of Object.entries(values)) {
    out = out.split(`{{${marker}}}`).join(value);
  }
  if (out.includes("{{") || out.includes("}}")) {
    throw new Error("dashboard template: unresolved {{marker}} after fill");
  }
  return out;
}

export {
  checkDashboardOrigin,
  dashboardHtmlHeaders,
  dashboardJsHeaders,
  dashboardCssHeaders,
  dashboardApiHeaders,
  encodeDashboardCursor,
  decodeDashboardCursor,
  fillDashboardTemplate,
};
