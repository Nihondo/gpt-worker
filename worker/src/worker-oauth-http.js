// OAuth resource-server + authorization-server metadata helpers
// (docs/plans/oauth-mcp-authentication.md, Phases 1-2): stateless discovery
// metadata builders, no env/sql/BridgeDO ownership. No imports from
// index.js (see CLAUDE.md's "index.js -> domain -> pure helpers"
// dependency direction).
//
// oauthError/parseOAuthForm (+ their own readTextWithLimit helper) live here
// too, despite not being metadata builders: both index.js's public OAuth
// routes (handleOAuthAuthorizeRoute/handleOAuthTokenRoute) and
// bridge-oauth.js's internal DO-resident handlers need the identical
// error-envelope shape and form-body parser, so this file is the one place
// both can import them from downward without either importing the other.

function oauthResourceUrl(requestUrl, workspaceId) {
  const u = new URL(requestUrl);
  u.pathname = workspaceId ? `/mcp/${workspaceId}` : "/mcp";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function oauthProtectedResourceMetadataUrl(requestUrl, workspaceId) {
  const u = new URL(requestUrl);
  u.pathname = workspaceId ? `/.well-known/oauth-protected-resource/mcp/${workspaceId}` : "/.well-known/oauth-protected-resource/mcp";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function oauthProtectedResourceMetadata(requestUrl, workspaceId) {
  const origin = new URL(requestUrl).origin;
  return {
    resource: oauthResourceUrl(requestUrl, workspaceId),
    authorization_servers: [origin],
  };
}

function oauthAuthorizationServerMetadata(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

function oauthError(error, description, status = 400) {
  const body = description ? { error, error_description: description } : { error };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Reads a request body as text under the same streaming size cap as
 *  worker-http.js's readJsonWithLimit, without JSON-parsing it — used for
 *  OAuth's application/x-www-form-urlencoded endpoint bodies. */
async function readTextWithLimit(request, maxBytes) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) return { tooLarge: true };

  const reader = request.body ? request.body.getReader() : null;
  if (!reader) return { value: "" };

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
  return { value: new TextDecoder().decode(buf) };
}

async function parseOAuthForm(request, maxBytes) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return { unsupportedMediaType: true };
  const read = await readTextWithLimit(request, maxBytes);
  if (read.tooLarge) return { tooLarge: true };
  return { params: new URLSearchParams(read.value) };
}

export { oauthResourceUrl, oauthProtectedResourceMetadataUrl, oauthProtectedResourceMetadata, oauthAuthorizationServerMetadata, oauthError, parseOAuthForm };
