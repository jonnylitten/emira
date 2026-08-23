// Regression test for the browser-orphan leak.
//
// Bug: when the parent (Claude Code) goes away by closing the stdio pipe with
// no SIGINT/SIGTERM, the server used to keep running — the live Chromium
// connection held its event loop open — so the server and its whole Chromium
// tree orphaned (reparented to launchd) and piled up one per reaped session.
//
// This drives the real dist/server.js over MCP stdio to open a browser, closes
// stdin (the exact parent-goes-away signal), and asserts that both the server
// and its Chromium exit rather than orphaning. Detects and cleans up ONLY
// emira's own temp-profile processes, so a developer's own Chromium windows are
// never touched. Auto-skips (exit 0) when no Chromium is available.
//
//   node scripts/orphan-lifecycle.mjs
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const BIN =
  process.env.EMIRA_EXECUTABLE_PATH?.trim() ||
  ["/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) =>
    existsSync(p),
  );

if (!existsSync(SERVER)) {
  console.error("SKIP: dist/server.js not built (run `npm run build`).");
  process.exit(0);
}
if (!BIN) {
  console.error("SKIP: no Chromium executable found; set EMIRA_EXECUTABLE_PATH.");
  process.exit(0);
}

const emiraProcs = () => {
  try {
    return execSync(`pgrep -f 'emira-profile-' || true`)
      .toString().trim().split("\n").filter(Boolean);
  } catch { return []; }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const before = new Set(emiraProcs());
const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, EMIRA_HEADLESS: "true", EMIRA_EXECUTABLE_PATH: BIN },
});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call",
             params: { name: "list_tabs", arguments: {} } });
    }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "orphan-test", version: "0" } } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try { execSync(`pkill -9 -f 'emira-profile-' 2>/dev/null || true`); } catch {}
  try { child.kill("SIGKILL"); } catch {}
};

const run = async () => {
  // Wait for the browser to launch (fresh emira-profile process appears).
  const t0 = Date.now();
  while (emiraProcs().filter((p) => !before.has(p)).length === 0) {
    if (Date.now() - t0 > 40000) throw new Error("browser never launched");
    await sleep(300);
  }
  const server = child.pid;

  // The event under test: parent goes away by closing the pipe, no signal.
  child.stdin.end();

  // The server must shut itself down and take its browser with it.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const orphans = emiraProcs().filter((p) => !before.has(p) && alive(Number(p)));
    if (!alive(server) && orphans.length === 0) {
      console.error("PASS: server exited and left no orphaned Chromium.");
      cleanup();
      process.exit(0);
    }
    await sleep(250);
  }
  const orphans = emiraProcs().filter((p) => !before.has(p) && alive(Number(p)));
  console.error(
    `FAIL: after stdin close, server alive=${alive(server)}, ` +
    `orphaned emira Chromium=${orphans.length}.`,
  );
  cleanup();
  process.exit(1);
};

run().catch((err) => { console.error("ERROR:", err.message); cleanup(); process.exit(1); });
