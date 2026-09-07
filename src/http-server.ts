#!/usr/bin/env node
// HTTP control surface — same actions as the MCP server, exposed over curl.
//
// Endpoints (action tools accept optional `tab_id` to address a non-active tab):
//   GET  /healthz                                                -> {ok}
//   POST /screenshot   {url?, wait_ms?, fullpage?, region?, detector?, interactive_only?, tab_id?}
//                                                                -> {count, image_path, labels[], url, detector, detect_ms, tab_id}
//   POST /click        {label, tab_id?}                          -> {ok, x, y, url, tab_id}
//   POST /type         {label, text, clear?, tab_id?}            -> {ok, url, tab_id}
//   POST /upload       {label, path, timeout_ms?, tab_id?}       -> {ok, count, url, tab_id}
//   POST /scroll       {direction, amount?, tab_id?}             -> {ok, url, tab_id}
//   POST /find_label   {description, limit?, tab_id?}            -> {matches[]}
//   POST /get_text     {label?, max_chars?, main_content_only?, tab_id?}
//                                                                -> {text, total_chars, truncated}
//   POST /press_key    {key, tab_id?}                            -> {ok, url, tab_id}
//   POST /hover        {label, tab_id?}                          -> {ok, x, y, url, tab_id}
//   POST /back         {tab_id?}                                 -> {ok, url, tab_id}
//   POST /forward      {tab_id?}                                 -> {ok, url, tab_id}
//   POST /wait_for_load {state?, timeout_ms?, tab_id?}           -> {ok, url, tab_id}
//   POST /clear_profile                                          -> {ok, profile_dir}
//   POST /get_cookies  {urls?}                                   -> {cookies[]}
//   POST /set_cookie   {name, value, url? | domain?, ...}        -> {ok}
//   POST /clear_cookies {name?, domain?, path?}                  -> {cleared}
//   POST /run_javascript {code, await_promise?, tab_id?}         -> {ok, result, url, tab_id}
//   POST /open_tab     {url?, wait_ms?}                          -> {ok, tab_id, url}
//   POST /switch_tab   {tab_id}                                  -> {ok, tab_id, url}
//   POST /list_tabs                                              -> {tabs: [{id, url, title, active}]}
//   POST /close_tab    {tab_id?}                                 -> {ok, closed_id, active_id}

import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { closeBrowser } from "./browser.js";
import { getEmira } from "./controller.js";
import {
  ESCALATED_ENDPOINTS,
  escalationEnabled,
  escalationError,
  ensureSecureDir,
  PolicyError,
} from "./policy.js";

const PORT = Number(process.env.EMIRA_HTTP_PORT ?? 17542);
const HOST = process.env.EMIRA_HTTP_HOST ?? "127.0.0.1";
// Per-user by construction on every platform. /tmp is shared on Linux, and
// os.tmpdir() only helps on macOS (where TMPDIR is already per-user), so
// neither is safe as a default on the shared machines this protects against.
// Deterministic too, so other local clients can compute the same path.
const SHOT_DIR = ensureSecureDir(
  process.env.EMIRA_SHOT_DIR ?? path.join(os.homedir(), ".emira", "shots"),
  "screenshot directory",
);

// Escalation policy is declared once in ./policy.ts and enforced inside the
// controller methods, so the MCP path gets it too. The endpoint check here is
// an early rejection so HTTP callers get a proper 403 instead of a 500.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Shared bearer token. Precedence: explicit env var, then a previously written
// token file, else a fresh random token. The active token is always written to
// the file (0600) so local clients discover it without env coordination.
const TOKEN_FILE = path.join(os.homedir(), ".emira", "http-token");
function resolveToken(): { token: string; generated: boolean } {
  if (process.env.EMIRA_HTTP_TOKEN) {
    return { token: process.env.EMIRA_HTTP_TOKEN, generated: false };
  }
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return { token: existing, generated: false };
  } catch {
    // no token file yet
  }
  return { token: randomUUID(), generated: true };
}
const { token: TOKEN, generated: TOKEN_GENERATED } = resolveToken();
// Same treatment as the screenshot directory: prove it is private, or refuse.
// A bearer token in a directory another user can read is not a bearer token.
ensureSecureDir(path.dirname(TOKEN_FILE), "token directory");
writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
chmodSync(TOKEN_FILE, 0o600);
if ((statSync(TOKEN_FILE).mode & 0o777) !== 0o600) {
  throw new Error(
    `refusing to start: ${TOKEN_FILE} is not mode 600 after chmod.`,
  );
}

const m = getEmira();
let shotCounter = 0;

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/healthz") {
    return send(res, 200, { ok: true });
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "method not allowed" });
  }

  // --- Security preamble ---------------------------------------------------
  // Loopback service holding live browser sessions. Reject anything that looks
  // like it came from a web page (a page you visit must not be able to drive
  // this), enforce a bearer token, and gate the escalated endpoints.
  if (req.headers.origin) {
    return send(res, 403, { error: "cross-origin requests are not allowed" });
  }
  const hostHeader = (req.headers.host ?? "").split(":")[0];
  if (!LOCAL_HOSTS.has(hostHeader)) {
    return send(res, 403, { error: "requests must target localhost" });
  }
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
  if (contentType !== "application/json") {
    return send(res, 415, { error: "content-type must be application/json" });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }
  const pathname = url.split("?")[0];
  if (ESCALATED_ENDPOINTS.has(pathname) && !escalationEnabled()) {
    return send(res, 403, { error: escalationError(pathname.slice(1)) });
  }

  const body = await readJson(req).catch(() => null);
  if (body === null) return send(res, 400, { error: "invalid json" });

  if (url === "/screenshot") {
    const result = await m.screenshot({
      url: body.url,
      wait_ms: body.wait_ms,
      fullpage: body.fullpage,
      region: body.region,
      detector: body.detector,
      interactive_only: body.interactive_only,
      tab_id: body.tab_id,
    });
    const imagePath = path.join(SHOT_DIR, `shot-${++shotCounter}.png`);
    writeFileSync(imagePath, result.image);
    return send(res, 200, {
      count: result.elements.length,
      image_path: imagePath,
      url: result.url,
      detector: result.detector,
      detect_ms: result.detect_ms,
      tab_id: result.tab_id,
      notice: result.notice,
      labels: result.elements.map((el) => ({
        label: el.label,
        type: el.type,
        text: el.text.slice(0, 120),
        interactive: el.interactive,
      })),
    });
  }

  if (url === "/click") {
    const r = await m.click(body.label, body.tab_id);
    return send(res, 200, {
      ok: true,
      x: Math.round(r.x),
      y: Math.round(r.y),
      url: r.url,
      tab_id: r.tab_id,
    });
  }

  if (url === "/type") {
    const r = await m.type(
      body.label,
      String(body.text),
      body.clear,
      body.tab_id,
    );
    return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
  }

  if (url === "/upload") {
    const r = await m.uploadAtLabel(
      body.label,
      body.path,
      body.timeout_ms,
      body.tab_id,
    );
    return send(res, 200, {
      ok: true,
      url: r.url,
      count: r.count,
      tab_id: r.tab_id,
    });
  }

  if (url === "/scroll") {
    const r = await m.scroll(body.direction, body.amount, body.tab_id);
    return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
  }

  if (url === "/find_label") {
    const matches = await m.findLabel(
      String(body.description),
      body.limit ?? 3,
      body.tab_id,
    );
    return send(res, 200, { matches });
  }

  if (url === "/press_key") {
    const r = await m.pressKey(String(body.key), body.tab_id);
    return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
  }

  if (url === "/hover") {
    const r = await m.hoverLabel(body.label, body.tab_id);
    return send(res, 200, {
      ok: true,
      x: Math.round(r.x),
      y: Math.round(r.y),
      url: r.url,
      tab_id: r.tab_id,
    });
  }

  if (url === "/back") {
    const r = await m.goBack(body.tab_id);
    return send(res, 200, r);
  }

  if (url === "/forward") {
    const r = await m.goForward(body.tab_id);
    return send(res, 200, r);
  }

  if (url === "/wait_for_load") {
    const r = await m.waitForLoad(
      body.state ?? "load",
      body.timeout_ms,
      body.tab_id,
    );
    return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
  }

  if (url === "/run_javascript") {
    const r = await m.runJavascript(
      String(body.code),
      Boolean(body.await_promise),
      body.tab_id,
    );
    return send(res, 200, {
      ok: true,
      result: r.result,
      url: r.url,
      tab_id: r.tab_id,
    });
  }

  if (url === "/clear_profile") {
    const { profileDir } = await m.clearProfile();
    return send(res, 200, { ok: true, profile_dir: profileDir });
  }

  if (url === "/get_text") {
    const text = await m.getPageText(
      body.label,
      body.main_content_only,
      body.tab_id,
    );
    const limit = body.max_chars ?? 4000;
    const truncated = text.length > limit;
    return send(res, 200, {
      text: truncated ? text.slice(0, limit) : text,
      total_chars: text.length,
      truncated,
    });
  }

  if (url === "/get_cookies") {
    const cookies = await m.getCookies(body.urls);
    return send(res, 200, { cookies });
  }

  if (url === "/set_cookie") {
    await m.setCookie(body);
    return send(res, 200, { ok: true });
  }

  if (url === "/clear_cookies") {
    const hasFilter = body.name || body.domain || body.path;
    const r = await m.clearCookies(
      hasFilter ? { name: body.name, domain: body.domain, path: body.path } : undefined,
    );
    return send(res, 200, r);
  }

  if (url === "/open_tab") {
    const r = await m.openTab(body.url, body.wait_ms);
    return send(res, 200, { ok: true, tab_id: r.tab_id, url: r.url });
  }

  if (url === "/switch_tab") {
    const r = await m.switchTab(body.tab_id);
    return send(res, 200, { ok: true, tab_id: r.tab_id, url: r.url });
  }

  if (url === "/list_tabs") {
    const tabs = await m.listTabs();
    return send(res, 200, { tabs });
  }

  if (url === "/close_tab") {
    const r = await m.closeTab(body.tab_id);
    return send(res, 200, { ok: true, ...r });
  }

  send(res, 404, { error: `unknown endpoint ${url}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    // Policy refusals are client errors, not server faults.
    if (err instanceof PolicyError) {
      return send(res, 400, { error: err.message });
    }
    console.error("handler error:", err);
    send(res, 500, { error: String(err?.message ?? err) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`emira http listening on ${HOST}:${PORT}, shots -> ${SHOT_DIR}`);
  if (TOKEN_GENERATED) {
    console.error(`[emira] generated auth token (also written to ${TOKEN_FILE}):`);
    console.error(`[emira]   ${TOKEN}`);
    console.error(`[emira] set EMIRA_HTTP_TOKEN to pin a fixed token across restarts.`);
  }
  console.error(
    `[emira] escalated tools ${escalationEnabled() ? "ENABLED" : "disabled"} ` +
      `(run_javascript, upload, cookies)`,
  );
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[emira] ${signal} received, closing browser…`);
  try {
    await closeBrowser();
  } catch (err) {
    console.error("[emira] error during browser close:", err);
  }
  console.error("[emira] shutdown complete");
  server.close(() => process.exit(0));
  // Don't hang forever on lingering keep-alive connections.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
