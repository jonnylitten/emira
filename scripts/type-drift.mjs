// Regression test for type() robustness: coordinate drift + long-text budget.
//
// 1) Coordinate drift: type()/click() used to replay the viewport coordinate
//    captured at screenshot time, so a scroll between capture and action drifted
//    the click onto whatever now sat there (often a link at the top), navigating
//    away and destroying a filled form. The fix resolves the node by its stamped
//    data-emira-ref and acts on it.
//
// 2) Long-text budget: the drift fix used pressSequentially with a fixed 5s
//    timeout, and since keys are sent at a per-character delay, that capped a
//    field at ~160 characters and silently truncated longer answers. The fix
//    scales the timeout (and speeds the cadence) with the text length.
//
// Drives the real Emira controller against a page with a link up top and a
// textarea far below. Auto-skips (exit 0) when no Chromium is available.
//
//   node scripts/type-drift.mjs
import http from "node:http";
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
process.env.EMIRA_ALLOW_ESCALATED = "1"; // for run_javascript (scroll + read-back)
delete process.env.EMIRA_PERSIST_PROFILE; // ephemeral, isolated profile

const { getEmira } = await import(DIST.href);
const { closeBrowser } = await import(
  new URL("../dist/browser.js", import.meta.url).href
);

// logo 0-500, spacer 500-1000, textarea ~1000, tall spacer after. Viewport 900.
const HTML = `<!doctype html><html><head><meta charset=utf8><style>
  body{margin:0;font-family:sans-serif}
  #logo{display:block;height:500px;background:#333;color:#fff;font-size:36px;text-align:center;line-height:500px;text-decoration:none}
  #spacer1{height:500px}
  #target{width:320px;height:90px;font-size:16px}
  #spacer2{height:3000px}
</style></head><body>
  <a id="logo" href="/navigated">LOGO — navigates away</a>
  <div id="spacer1"></div>
  <textarea id="target" placeholder="target textarea"></textarea>
  <div id="spacer2"></div>
</body></html>`;

const server = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/navigated")) {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>navigated</title>navigated away");
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const SHORT = "HELLO_DRIFT_TEST";
const LONG = "The quick brown fox jumps. ".repeat(48); // ~1296 chars, far past the old ~160 cap
let passDrift = false;
let passLong = false;
let detail = "";
try {
  const m = getEmira();
  await m.screenshot({ url }); // load (scroll 0)
  await m.runJavascript("window.scrollTo(0, 900);"); // bring the textarea into view
  const shot = await m.screenshot({}); // label + stamp at scroll 900
  const ta = shot.elements.find((e) => e.type === "textarea");
  if (!ta) throw new Error("textarea was not labeled");

  // 1) Drift: scroll away, then type; must hit the textarea, not the logo.
  await m.runJavascript("window.scrollTo(0, 0);");
  await m.type(ta.label, SHORT);
  const s1 = await m.runJavascript(
    `return JSON.stringify({ path: location.pathname, val: (document.getElementById('target')||{}).value ?? null });`,
  );
  const r1 = JSON.parse(s1.result);
  passDrift = r1.path === "/" && r1.val === SHORT;

  // 2) Long text: a long answer must land in full, not truncate at the timeout.
  await m.type(ta.label, LONG, true);
  const s2 = await m.runJavascript(
    `return String((document.getElementById('target')||{}).value?.length ?? -1);`,
  );
  const got = Number(s2.result);
  passLong = got === LONG.length;
  detail = `drift(path=${r1.path} val=${JSON.stringify(r1.val)})  long(got=${got} want=${LONG.length})`;
} catch (e) {
  detail = "threw: " + (e instanceof Error ? e.message : String(e));
} finally {
  await closeBrowser().catch(() => {});
  server.close();
}

const pass = passDrift && passLong;
console.error(
  pass
    ? `PASS: ${detail}`
    : `FAIL: [drift=${passDrift} long=${passLong}] ${detail}`,
);
process.exit(pass ? 0 : 1);
