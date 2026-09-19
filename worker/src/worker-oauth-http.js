// OAuth resource-server + authorization-server metadata helpers
// (docs/plans/oauth-mcp-authentication.md, Phases 1-2): stateless discovery
// metadata builders, no env/sql/BridgeDO ownership. No imports from
// index.js (see CLAUDE.md's "index.js -> domain -> pure helpers"
// dependency direction).

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

export { oauthResourceUrl, oauthProtectedResourceMetadataUrl, oauthProtectedResourceMetadata, oauthAuthorizationServerMetadata };
