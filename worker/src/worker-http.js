// Stateless Worker HTTP helpers: no env/sql/BridgeDO ownership, no imports
// from index.js (see index.js's "Top-level Worker" comment and CLAUDE.md's
// "index.js -> domain -> pure helpers" dependency direction). Anything here
// depends only on platform globals (Request/Response/URL/crypto/TextEncoder).

// "default" is the one pre-existing exception: the original single-tenant
// deployment's Durable Object was idFromName("default") verbatim, so the
// migration path (see BridgeDO.migrateDefault) must be able to address that
// exact same instance under the new multi-tenant routing. Every workspace
// provisioned from here on gets a fresh 16-hex-char id instead.
const WORKSPACE_ID_RE = /^[0-9a-f]{16}$/;
function isValidWorkspaceId(id) {
  return id === "default" || WORKSPACE_ID_RE.test(id);
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ALLOWED_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // server-to-server calls (ChatGPT backend, curl, CLI) send none
  return ALLOWED_ORIGINS.has(origin);
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/** Reads and JSON-parses a request body while enforcing maxBytes *during*
 *  the read — not just by checking Content-Length (absent for chunked
 *  requests, and not to be trusted anyway) and not just by inspecting a
 *  field's length after the whole body has already been buffered and
 *  parsed. Returns { tooLarge } if the cap is hit, aborting the read early;
 *  otherwise { value } (parsed JSON) or { parseError: true }. */
async function readJsonWithLimit(request, maxBytes) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) return { tooLarge: true };

  const reader = request.body ? request.body.getReader() : null;
  if (!reader) return { value: undefined };

  let total = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { parseError: true };
  }
}

// Generic base64url codecs. Used directly by OAuth's PKCE challenge
// derivation (index.js's pkceChallengeFromVerifier) and, downstream, by
// worker-dashboard-http.js's opaque pagination cursors — kept here rather
// than duplicated so dashboard code can depend downward without importing
// index.js.
function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const normalized = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { isValidWorkspaceId, constantTimeEqual, checkOrigin, json, byteLength, readJsonWithLimit, base64UrlEncode, base64UrlDecode };
