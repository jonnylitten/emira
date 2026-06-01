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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeBrowser } from "./browser.js";
import { getMarksman } from "./controller.js";
const PORT = Number(process.env.MARKSMAN_HTTP_PORT ?? 17542);
const SHOT_DIR = process.env.MARKSMAN_SHOT_DIR ?? "/tmp/marksman";
mkdirSync(SHOT_DIR, { recursive: true });
const m = getMarksman();
let shotCounter = 0;
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (!body)
                return resolve({});
            try {
                resolve(JSON.parse(body));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}
async function handle(req, res) {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
        return send(res, 200, { ok: true });
    }
    if (req.method !== "POST") {
        return send(res, 405, { error: "method not allowed" });
    }
    const body = await readJson(req).catch(() => null);
    if (body === null)
        return send(res, 400, { error: "invalid json" });
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
        const r = await m.type(body.label, String(body.text), body.clear, body.tab_id);
        return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
    }
    if (url === "/upload") {
        const r = await m.uploadAtLabel(body.label, body.path, body.timeout_ms, body.tab_id);
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
        const matches = await m.findLabel(String(body.description), body.limit ?? 3, body.tab_id);
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
        const r = await m.waitForLoad(body.state ?? "load", body.timeout_ms, body.tab_id);
        return send(res, 200, { ok: true, url: r.url, tab_id: r.tab_id });
    }
    if (url === "/run_javascript") {
        const r = await m.runJavascript(String(body.code), Boolean(body.await_promise), body.tab_id);
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
        const text = await m.getPageText(body.label, body.main_content_only, body.tab_id);
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
        const r = await m.clearCookies(hasFilter ? { name: body.name, domain: body.domain, path: body.path } : undefined);
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
//# sourceMappingURL=http-server.js.map