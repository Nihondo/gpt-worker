// Parses instructions.md into the two connector-shaped operating-protocol
// variants ("shared" / "dedicated"). This file deliberately contains no
// protocol prose of its own — instructions.md is the single source of truth,
// mirrored in README.md/README_ja.md for human readers.
//
// Worker-owned static text: it is compiled into the Worker from this
// repository, never sourced from a workspace, the local CLI, or ChatGPT.
// That is why it is trusted (see the "Operating instructions" section in
// reference/protocol.md). Never interpolate anything into it except the
// connector-shape fragments defined in instructions.md itself.
import RAW from "./instructions.md";

const FRAGMENT_RE = /^<!--\s*gpt-worker:fragment\s+(\w+)\s+(shared|dedicated)\s*-->\s*$/;
const BODY_MARKER_RE = /^<!--\s*gpt-worker:body\s*-->\s*$/;

function parse(raw) {
  const lines = raw.split("\n");
  const fragments = {};
  let bodyStart = -1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BODY_MARKER_RE.test(line)) {
      bodyStart = i + 1;
      break;
    }
    const match = FRAGMENT_RE.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const [, key, connector] = match;
    const valueLines = [];
    i += 1;
    while (i < lines.length && !FRAGMENT_RE.test(lines[i]) && !BODY_MARKER_RE.test(lines[i])) {
      valueLines.push(lines[i]);
      i += 1;
    }
    fragments[`${key}:${connector}`] = valueLines.join("\n").trim();
  }
  if (bodyStart === -1) throw new Error("instructions.md: missing <!-- gpt-worker:body --> marker");
  return { fragments, body: lines.slice(bodyStart).join("\n").trim() };
}

function render(body, fragments, connector) {
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const value = fragments[`${key}:${connector}`];
    if (value === undefined) throw new Error(`instructions.md: missing fragment ${key}/${connector}`);
    return value;
  });
}

const { fragments, body } = parse(RAW);

export const OPERATING_INSTRUCTIONS = Object.freeze({
  shared: render(body, fragments, "shared"),
  dedicated: render(body, fragments, "dedicated"),
});

export function operatingInstructions(connector) {
  return connector === "shared" ? OPERATING_INSTRUCTIONS.shared : OPERATING_INSTRUCTIONS.dedicated;
}
