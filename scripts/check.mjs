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
  "worker/src/index.js",
  "worker/src/instructions.js",
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
