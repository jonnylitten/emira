#!/usr/bin/env node
// HTTP control surface — same actions as the MCP server, exposed over curl.
//
// Endpoints:
//   GET  /healthz                                                -> {ok}
//   POST /screenshot   {url?, wait_ms?, fullpage?, region?}      -> {count, image_path, labels[]}
//   POST /click        {label}                                   -> {ok, x, y}
//   POST /type         {label, text, clear?}                     -> {ok}
//   POST /upload       {label, path, timeout_ms?}                -> {ok, count}
//   POST /clear_profile                                          -> {ok, profile_dir}
//   POST /run_javascript {code, await_promise?}                  -> {ok, result, url}
//   POST /scroll       {direction, amount?}                      -> {ok}
//   POST /find_label   {description, limit?}                     -> {matches[]}
//   POST /get_text     {label?, max_chars?}                      -> {text}
//   POST /press_key    {key}                                     -> {ok}
//   POST /hover        {label}                                   -> {ok, x, y}
//   POST /back                                                   -> {ok}
//   POST /forward                                                -> {ok}
//   POST /wait_for_load {state?, timeout_ms?}                    -> {ok}
//
// Screenshots write to MARKSMAN_SHOT_DIR (default /tmp/marksman) so callers
// can Read the PNG by path rather than shuttling base64 over JSON.

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeBrowser } from "./browser.js";
import { getMarksman } from "./controller.js";

const PORT = Number(process.env.MARKSMAN_HTTP_PORT ?? 17542);
const SHOT_DIR = process.env.MARKSMAN_SHOT_DIR ?? "/tmp/marksman";
mkdirSync(SHOT_DIR, { recursive: true });

const m = getMarksman();
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
    });
    const imagePath = path.join(SHOT_DIR, `shot-${++shotCounter}.png`);
    writeFileSync(imagePath, result.image);
    return send(res, 200, {
      count: result.elements.length,
      image_path: imagePath,
      url: result.url,
      detector: result.detector,
      detect_ms: result.detect_ms,
      labels: result.elements.map((el) => ({
        label: el.label,
        type: el.type,
        text: el.text.slice(0, 120),
        interactive: el.interactive,
      })),
    });
  }

  if (url === "/click") {
    const r = await m.click(body.label);
    return send(res, 200, {
      ok: true,
      x: Math.round(r.x),
      y: Math.round(r.y),
      url: r.url,
    });
  }

  if (url === "/type") {
    const r = await m.type(body.label, String(body.text), body.clear);
    return send(res, 200, { ok: true, url: r.url });
  }

  if (url === "/upload") {
    const r = await m.uploadAtLabel(body.label, body.path, body.timeout_ms);
    return send(res, 200, { ok: true, url: r.url, count: r.count });
  }

  if (url === "/scroll") {
    const r = await m.scroll(body.direction, body.amount);
    return send(res, 200, { ok: true, url: r.url });
  }

  if (url === "/find_label") {
    const matches = m.findLabel(String(body.description), body.limit ?? 3);
    return send(res, 200, { matches });
  }

  if (url === "/press_key") {
    const r = await m.pressKey(String(body.key));
    return send(res, 200, { ok: true, url: r.url });
  }

  if (url === "/hover") {
    const r = await m.hoverLabel(body.label);
    return send(res, 200, {
      ok: true,
      x: Math.round(r.x),
      y: Math.round(r.y),
      url: r.url,
    });
  }

  if (url === "/back") {
    const r = await m.goBack();
    return send(res, 200, r);
  }

  if (url === "/forward") {
    const r = await m.goForward();
    return send(res, 200, r);
  }

  if (url === "/wait_for_load") {
    const r = await m.waitForLoad(body.state ?? "load", body.timeout_ms);
    return send(res, 200, { ok: true, url: r.url });
  }

  if (url === "/run_javascript") {
    const { result, url: pageUrl } = await m.runJavascript(
      String(body.code),
      Boolean(body.await_promise),
    );
    return send(res, 200, { ok: true, result, url: pageUrl });
  }

  if (url === "/clear_profile") {
    const { profileDir } = await m.clearProfile();
    return send(res, 200, { ok: true, profile_dir: profileDir });
  }

  if (url === "/get_text") {
    const text = await m.getPageText(body.label, body.main_content_only);
    const limit = body.max_chars ?? 4000;
    const truncated = text.length > limit;
    return send(res, 200, {
      text: truncated ? text.slice(0, limit) : text,
      total_chars: text.length,
      truncated,
    });
  }

  send(res, 404, { error: `unknown endpoint ${url}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("handler error:", err);
    send(res, 500, { error: String(err?.message ?? err) });
  });
});

server.listen(PORT, () => {
  console.log(`marksman http listening on :${PORT}, shots -> ${SHOT_DIR}`);
});

const shutdown = async () => {
  await closeBrowser();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
