// Regression test: a fullpage capture must label below-the-fold controls.
//
// The DOM detector ran against the live viewport (getBoundingClientRect, skip
// rect.top > viewportH), but fullpage:true captures the whole scrollable page,
// so footer/below-fold controls rendered in the image yet were never labeled.
// Fix: on fullpage, cover the whole document (document-coordinate bboxes, no
// viewport clip). Plus an advisory (not a cap) when a fullpage capture is dense.
//
//   node scripts/detect-fullpage.mjs
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
delete process.env.EMIRA_PERSIST_PROFILE;

const { getEmira } = await import(DIST.href);
const { closeBrowser } = await import(
  new URL("../dist/browser.js", import.meta.url).href
);

// Tall page: one button above the fold, two controls in a footer far below it.
const TALL = `<!doctype html><meta charset=utf8><body style="margin:0;font-family:sans-serif">
  <button id="top">Top button (above the fold)</button>
  <div style="height:2000px"></div>
  <div style="border-top:1px solid #ccc;padding:12px">
    <button id="continue">Continue</button>
    <a class="btn" id="finish" href="#">Finish Later</a>
  </div></body>`;
// Dense tall page: 60 inputs, to exercise the advisory.
const DENSE = `<!doctype html><meta charset=utf8><body style="margin:0;font-family:sans-serif">${Array.from(
  { length: 60 },
  (_, i) => `<div style="padding:14px"><input placeholder="field ${i}"></div>`,
).join("")}</body>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end((req.url || "").startsWith("/dense") ? DENSE : TALL);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let passFooter = false;
let passAdvisory = false;
let detail = "";
try {
  const m = getEmira();
  const full = await m.screenshot({ url: base + "/", fullpage: true });
  const top = full.elements.some((e) => /top button/i.test(e.text || ""));
  const footer = full.elements.some((e) => /continue|finish/i.test(e.text || ""));
  passFooter = top && footer;

  const dense = await m.screenshot({ url: base + "/dense", fullpage: true });
  passAdvisory =
    dense.elements.length > 50 &&
    typeof dense.notice === "string" &&
    /run_javascript|region/.test(dense.notice);
  detail = `footer(top=${top} footer=${footer})  advisory(labels=${dense.elements.length} notice=${JSON.stringify(dense.notice)?.slice(0, 40)})`;
} catch (e) {
  detail = "threw: " + (e instanceof Error ? e.message : String(e));
} finally {
  await closeBrowser().catch(() => {});
  server.close();
}

const pass = passFooter && passAdvisory;
console.error(
  pass ? `PASS: ${detail}` : `FAIL: [footer=${passFooter} advisory=${passAdvisory}] ${detail}`,
);
process.exit(pass ? 0 : 1);
