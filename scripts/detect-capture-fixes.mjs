// Regression test for two screenshot/detect fixes.
//
// A) Styled file-upload controls: a <label> wrapping a display:none
//    <input type=file> is the near-universal styled-uploader pattern. The
//    redundancy check dropped the <label> (assuming its input would be labeled)
//    while the visibility filter dropped the input, leaving the upload button
//    unreachable. Fixed by judging redundancy against elements that will
//    actually be labeled. Red-greenable.
//
// B) backdrop-filter: Chromium's page.screenshot() stalls past the timeout on
//    pages using CSS backdrop-filter. Fixed by neutralizing it for the capture.
//    The hang is a headed/GPU behavior, so headless can't reproduce it; this
//    just confirms the fix still produces a valid screenshot on such a page.
//
//   node scripts/detect-capture-fixes.mjs
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

const UPLOAD_HTML = `<!doctype html><meta charset=utf8><body style="font-family:sans-serif">
  <div>Resume*</div>
  <label class="btn" style="display:inline-block;padding:8px 16px;background:#06c;color:#fff;border-radius:6px">
    Upload file<input type="file" style="display:none">
  </label>
</body>`;

const BACKDROP_HTML = `<!doctype html><meta charset=utf8><style>
  .overlay{position:fixed;inset:0;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(0,0,0,.2)}
</style><body style="font-family:sans-serif">
  <h1>Backdrop filter page</h1><button id="b">A button</button>
  <div class="overlay"></div>
</body>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end((req.url || "").startsWith("/backdrop") ? BACKDROP_HTML : UPLOAD_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let passUpload = false;
let passBackdrop = false;
let detail = "";
try {
  const m = getEmira();
  // A) styled upload <label> must be reachable (labeled), not dropped.
  const shotA = await m.screenshot({ url: base + "/" });
  passUpload = shotA.elements.some((e) => /upload file/i.test(e.text || ""));

  // B) backdrop-filter page must screenshot without hanging.
  const t0 = Date.now();
  const shotB = await m.screenshot({ url: base + "/backdrop" });
  const ms = Date.now() - t0;
  passBackdrop = Buffer.isBuffer(shotB.image) && shotB.image.length > 0 && ms < 15000;
  detail = `upload(reachable=${passUpload})  backdrop(ok=${passBackdrop} ${ms}ms ${shotB.image?.length || 0}B)`;
} catch (e) {
  detail = "threw: " + (e instanceof Error ? e.message : String(e));
} finally {
  await closeBrowser().catch(() => {});
  server.close();
}

const pass = passUpload && passBackdrop;
console.error(
  pass ? `PASS: ${detail}` : `FAIL: [upload=${passUpload} backdrop=${passBackdrop}] ${detail}`,
);
process.exit(pass ? 0 : 1);
