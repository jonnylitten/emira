# Development

```bash
npm run build         # tsc → dist/
npm run dev           # tsc --watch
npm run typecheck     # tsc --noEmit
npm test              # vitest run, pure-function unit tests
npm run test:watch
```

Tests cover `scoring.ts`, `geometry.ts`, and `annotate.ts` (the parts that don't need a browser). End-to-end coverage is via agent runs against real sites. See the smoke driver at `scripts/smoke.mjs` for the MCP wire protocol if you want to write your own.

## Project layout

```
.claude-plugin/
└── plugin.json              Plugin manifest (name, version, mcpServers, userConfig)
skills/
└── emira/SKILL.md        Skill description, loaded into Claude's context on plugin activation
hooks/
└── hooks.json               SessionStart hook → scripts/install-plugin-deps.sh
scripts/
├── install-plugin-deps.sh   Idempotent npm install + Playwright Chromium install into $CLAUDE_PLUGIN_DATA
├── setup-omniparser.sh      One-shot installer for the omniparser detector
└── smoke.mjs                MCP stdio smoke driver
src/
├── server.ts                MCP stdio server (the plugin's MCP entry point)
├── http-server.ts           HTTP server (for curl / out-of-Claude-Code scripting)
├── controller.ts            Shared action layer: owns per-tab label maps, drives every tool
├── browser.ts               Playwright session singleton (profile, viewport, executable)
├── tabs.ts                  Tab registry: ids, active tab, popup auto-registration
├── detect.ts                DOM detector implementation
├── detector.ts              Dispatcher: dom | omniparser
├── detectors/
│   └── omniparser.ts        Node-side Python sidecar client
├── annotate.ts              sharp + SVG composite for the marked image
├── scoring.ts               find_label fuzzy ranker
├── geometry.ts              bbox helpers (intersect, containment, suppression)
├── types.ts
└── *.test.ts                vitest suites
omniparser/
├── infer.py                 Python sidecar (real OmniParser + --stub mode)
├── inference-requirements.txt
└── requirements.txt
```
