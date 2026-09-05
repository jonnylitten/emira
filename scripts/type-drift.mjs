// Regression test for the coordinate-drift data-loss bug.
//
// Bug: type()/click() replayed the viewport coordinate captured at screenshot
// time. If the page scrolled between capture and the action, the click landed
// on whatever now occupied that viewport point. On a form well down the page
// that was often a link at the top, so a type() aimed at a textarea navigated
// away and destroyed the filled form, returning {ok:true}.
//
// This drives the real Emira controller against a page with a link up top and a
// textarea far below: it labels the textarea while scrolled to it, scrolls back
// to the top so the textarea's stored coordinates now sit over the link, then
// types. The pre-fix coordinate path clicks the link and navigates; the fix
// resolves the node by its stamped data-emira-ref and acts on it, so drift
// cannot happen. Auto-skips (exit 0) when no Chromium is available.
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
const { closeBrowser } = await import(new URL("../dist/browser.js", import.meta.url).href);

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

const TEXT = "HELLO_DRIFT_TEST";
let pass = false;
let detail = "";
try {
  const m = getEmira();
  await m.screenshot({ url }); // load (scroll 0)
  await m.runJavascript("window.scrollTo(0, 900);"); // bring the textarea into view
  const shot = await m.screenshot({}); // label + stamp at scroll 900
  const ta = shot.elements.find((e) => e.type === "textarea");
  if (!ta) throw new Error("textarea was not labeled");
  await m.runJavascript("window.scrollTo(0, 0);"); // DRIFT: old coords now over the logo
  await m.type(ta.label, TEXT); // fix: acts on the node; bug: clicks the logo, navigates
  const state = await m.runJavascript(
    `return JSON.stringify({ path: location.pathname, val: (document.getElementById('target')||{}).value ?? null });`,
  );
  const { path, val } = JSON.parse(state.result);
  detail = `path=${path} val=${JSON.stringify(val)}`;
  pass = path === "/" && val === TEXT;
} catch (e) {
  detail = "threw: " + (e instanceof Error ? e.message : String(e));
} finally {
  await closeBrowser().catch(() => {});
  server.close();
}

console.error(
  pass
    ? `PASS: no navigation, text landed in the textarea after drift (${detail})`
    : `FAIL: ${detail}`,
);
process.exit(pass ? 0 : 1);
