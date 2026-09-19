#!/usr/bin/env node
// Syntax-checks every hand-written source file. No external deps — this is
// what `npm run check` (and `npm run verify`, alongside the test suite) runs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const files = [
  ...fs
    .readdirSync("bridge")
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join("bridge", f)),
  // worker/src root: index.js, instructions.js, and every worker-*.js /
  // bridge-schema.js helper module extracted from index.js. Enumerated
  // dynamically (not a fixed path list) so a future root-level module is
  // covered automatically, without also picking up the dashboard/
  // subdirectory handled separately below.
  ...fs
    .readdirSync("worker/src", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join("worker/src", entry.name)),
  // Browser-side dashboard assets: imported as opaque Text-module strings
  // (see worker/wrangler.jsonc's `rules`), so nothing else parses these as
  // JS — check their syntax here instead.
  ...fs
    .readdirSync("worker/src/dashboard")
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("worker/src/dashboard", f)),
];

let failed = false;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
    console.log(`OK   ${f}`);
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
