// Lets worker/src/instructions.js's `import RAW from "./instructions.md"`
// resolve under plain Node, matching the Text-module rule Workers applies
// via worker/wrangler.jsonc. Loaded with `node --test --import` (see
// package.json's "test" script).
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".md")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
    }
    return nextLoad(url, context);
  },
});
