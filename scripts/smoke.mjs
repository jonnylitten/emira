// Drives the marksman server over stdio and exercises every tool against
// example.com. Run with: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const server = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, MARKSMAN_HEADLESS: "true" },
});

let buf = "";
const pending = new Map();

server.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  while (true) {
    const nl = buf.indexOf("\n");
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  server.stdin.write(payload + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

async function main() {
  // Initialize
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  console.log("initialized:", init.result?.serverInfo);

  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  // List tools
  const tools = await send("tools/list", {});
  console.log(
    "tools:",
    tools.result.tools.map((t) => t.name),
  );

  // screenshot_mark on example.com
  const shot = await send("tools/call", {
    name: "screenshot_mark",
    arguments: { url: "https://example.com" },
  });
  if (shot.error) {
    console.error("screenshot_mark error:", shot.error);
    process.exit(1);
  }
  const image = shot.result.content.find((c) => c.type === "image");
  const text = shot.result.content.find((c) => c.type === "text");
  console.log("text:", text?.text);
  if (image) {
    writeFileSync("/tmp/marksman-smoke.png", Buffer.from(image.data, "base64"));
    console.log("saved marked screenshot to /tmp/marksman-smoke.png");
  }

  // Try scroll
  const scrolled = await send("tools/call", {
    name: "scroll",
    arguments: { direction: "down", amount: 100 },
  });
  console.log("scroll:", scrolled.result?.content?.[0]?.text);

  // Click label 1 — should be the "More information..." link on example.com
  const click = await send("tools/call", {
    name: "click_label",
    arguments: { label: 1 },
  });
  console.log("click:", click.result?.content?.[0]?.text ?? click.error);

  server.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  server.kill();
  process.exit(1);
});
