// Regression test: a closed browser must self-heal, not wedge the server.
//
// Bug: getTabs() guarded on `!session`, which is only falsy on the first call.
// Once launched, it returned the same registry forever. If the user closed the
// Chromium window, the context was dead but the session stayed, so every tool
// threw "Target ... has been closed" and list_tabs reported the dead browser as
// merely "(no tabs open)". Only a process restart recovered.
//
// Fix: a context "close" handler (and a proactive liveness check) clear the
// session, so the next call transparently relaunches. This closes the context
// out from under the session and asserts the next call still works.
//
//   node scripts/browser-selfheal.mjs
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIST = new URL("../dist/controller.js", import.meta.url);
const BIN =
  process.env.EMIRA_EXECUTABLE_PATH?.trim() ||
  ["/Applications/Chromium.app/Contents/MacOS/Chromium"].find(existsSync);

if (!existsSync(fileURLToPath(DIST))) {
  console.error("SKIP: dist not built (run `npm run build`).");
  process.exit(0);
}
if (!BIN) {
  console.error("SKIP: no Chromium executable; set EMIRA_EXECUTABLE_PATH.");
  process.exit(0);
}

process.env.EMIRA_HEADLESS = "true";
process.env.EMIRA_EXECUTABLE_PATH = BIN;
delete process.env.EMIRA_PERSIST_PROFILE;

const { getEmira } = await import(DIST.href);
const { getContext, closeBrowser } = await import(
  new URL("../dist/browser.js", import.meta.url).href
);

let pass = false;
let detail = "";
try {
  const m = getEmira();
  const before = await m.listTabs(); // launches the browser (>=1 tab)
  const ctx = await getContext();
  await ctx.close(); // simulate the user closing the browser window / a crash
  // Fixed: the "close" handler nulled the session, so this relaunches.
  // Broken: the stale session reports the dead browser as empty, or throws.
  const after = await m.listTabs();
  detail = `before=${before.length} tab(s), afterClose=${after.length} tab(s)`;
  pass = before.length >= 1 && after.length >= 1;
} catch (e) {
  detail = "threw (no self-heal): " + (e instanceof Error ? e.message : String(e));
} finally {
  await closeBrowser().catch(() => {});
}

console.error(
  pass
    ? `PASS: browser self-healed after close (${detail})`
    : `FAIL: ${detail}`,
);
process.exit(pass ? 0 : 1);
