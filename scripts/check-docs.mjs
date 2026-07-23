#!/usr/bin/env node
// Doc drift check: derive counts from source and fail the build when a
// published doc disagrees. Derive, don't transcribe — tool counts have
// drifted in five places before, and the config count survived a dedicated
// fix pass. This makes silent drift a build failure instead.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const walk = (dir) =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

const DOCS = [
  "README.md",
  "CLAUDE.md",
  "ROADMAP.md",
  "skills/marksman/SKILL.md",
  "docs/field-report-2026-07-app-store-connect.md",
];
const errors = [];
const SCRUBBED = new RegExp("pig" + "eon", "i");

// Truths derived from source.
const toolCount = (read("src/server.ts").match(/^server\.tool\(/gm) ?? []).length;
const endpointCount = (read("src/http-server.ts").match(/if \(url === "\//g) ?? []).length;
if (toolCount !== endpointCount) {
  errors.push(`source mismatch: ${toolCount} MCP tools vs ${endpointCount} HTTP endpoints`);
}
const userConfigKeys = Object.keys(JSON.parse(read(".claude-plugin/plugin.json")).userConfig);
const tsFiles = walk("src").filter((f) => f.endsWith(".ts"));
const envSource = new Set(
  tsFiles
    .flatMap((f) => read(f).match(/MARKSMAN_[A-Z_]+/g) ?? [])
    .concat(read("omniparser/infer.py").match(/MARKSMAN_[A-Z_]+/g) ?? []),
);

// 1. Every tool/endpoint/route count stated in a doc matches the derived count.
// The lookbehind skips approximations about other projects ("~8 tools").
for (const doc of DOCS) {
  const text = read(doc);
  for (const m of text.matchAll(/(?<![~\d.])(\d+)(?= (?:marksman |MCP |HTTP |POST |stdio )*(?:tools?|endpoints?)\b)/g)) {
    if (Number(m[1]) !== toolCount) {
      errors.push(`${doc}: states "${m[0]}" tools/endpoints, source has ${toolCount}`);
    }
  }
  for (const m of text.matchAll(/(?<![~\d.])(\d+)(?= routes\b)/g)) {
    if (Number(m[1]) !== endpointCount + 1) {
      errors.push(`${doc}: states "${m[0]}" routes, source has ${endpointCount + 1} (endpoints + healthz)`);
    }
  }
  // Style gate for published docs: no em or en dashes, no scrubbed codename.
  // The codename pattern is split so this script never matches its own grep.
  if (/[—–]/.test(text)) errors.push(`${doc}: contains an em or en dash`);
  if (SCRUBBED.test(text)) errors.push(`${doc}: contains the scrubbed codename`);
}
if (SCRUBBED.test(read(".claude-plugin/plugin.json") + tsFiles.map(read).join(""))) {
  errors.push(`plugin.json or src: contains the scrubbed codename`);
}

// 2. README's plugin-config table matches plugin.json's userConfig keys.
const readme = read("README.md");
const cfgSection = readme.split("### Plugin configuration")[1]?.split("\n### ")[0] ?? "";
const rows = [...cfgSection.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
for (const k of userConfigKeys) {
  if (!rows.includes(k)) errors.push(`README plugin-config table is missing userConfig key "${k}"`);
}
for (const k of rows) {
  if (!userConfigKeys.includes(k)) errors.push(`README plugin-config table lists "${k}", not in plugin.json`);
}
const WORDS = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve".split(" ").map((w, i) => [w, i]),
);
const claim = readme.match(/exposes (\w+) `userConfig` options/);
if (claim) {
  const n = WORDS[claim[1].toLowerCase()] ?? Number(claim[1]);
  if (n !== userConfigKeys.length) {
    errors.push(`README says "${claim[1]}" userConfig options, plugin.json has ${userConfigKeys.length}`);
  }
}

// 3. Env vars: everything the source reads is documented in README, and
// everything README documents is actually read somewhere (TS or the sidecar).
const envDocumented = new Set(readme.match(/MARKSMAN_[A-Z_]+/g) ?? []);
for (const v of envSource) {
  if (!envDocumented.has(v)) errors.push(`env var ${v} is read by source but not documented in README`);
}
for (const v of envDocumented) {
  if (!envSource.has(v)) errors.push(`env var ${v} is documented in README but never read by source`);
}

if (errors.length) {
  console.error("check-docs: FAILED");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `check-docs: OK (${toolCount} tools, ${endpointCount} endpoints, ` +
    `${userConfigKeys.length} userConfig options, ${envSource.size} env vars)`,
);
