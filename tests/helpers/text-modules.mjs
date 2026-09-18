// Lets Worker source files' Text-module imports (worker/src/instructions.js's
// `import RAW from "./instructions.md"`, and worker/src/index.js's dashboard
// asset imports from ./dashboard/*.html and ./dashboard/*.js) resolve under
// plain Node the same way Cloudflare Workers resolves them via the `rules`
// entries in worker/wrangler.jsonc: as a plain default-exported string, never
// parsed/executed as Markdown, HTML, or JS. Loaded with `node --test --import`
// (see package.json's "test" script).
//
// The dashboard match is deliberately narrow — only worker/src/dashboard/*
// .html and .js files — so this hook never intercepts an arbitrary project
// .js import (which must keep executing as real JS under Node) and mirrors
// wrangler.jsonc's own dashboard-scoped globs, not a blanket "**/*.js".
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DASHBOARD_TEXT_ASSET_RE = /\/worker\/src\/dashboard\/[^/]+\.(?:html|js)$/;

function asTextModule(url) {
  const source = readFileSync(fileURLToPath(url), "utf8");
  return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".md")) return asTextModule(url);
    if (DASHBOARD_TEXT_ASSET_RE.test(url)) return asTextModule(url);
    return nextLoad(url, context);
  },
});
