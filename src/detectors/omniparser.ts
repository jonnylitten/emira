// Node-side client for the Python OmniParser sidecar.
//
// The sidecar is a long-running Python process that loads the OmniParser
// model once and serves repeated screenshot → element-list requests over
// line-delimited JSON on stdin/stdout. We spawn it lazily on first detect()
// and keep it alive for the marksman process lifetime.
//
// Protocol (one JSON object per line):
//   Sidecar → Node: {"event":"ready"} on startup
//   Node → Sidecar: {"request_id":"<id>", "image_path":"/tmp/.../shot.png"}
//   Sidecar → Node: {"request_id":"<id>", "elements":[...]} or {"request_id":"<id>", "error":"..."}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DetectedElement } from "../types.js";

const SIDECAR_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../omniparser",
);

interface PendingRequest {
  resolve: (elements: DetectedElement[]) => void;
  reject: (err: Error) => void;
}

class OmniParserClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();

  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const venvPython = path.join(SIDECAR_DIR, ".venv/bin/python");
      const python = existsSync(venvPython) ? venvPython : "python3";
      const inferScript = path.join(SIDECAR_DIR, "infer.py");

      if (!existsSync(inferScript)) {
        return reject(
          new Error(
            `OmniParser sidecar not found at ${inferScript}. Run scripts/setup-omniparser.sh first.`,
          ),
        );
      }

      const proc = spawn(python, [inferScript], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        // Run the sidecar in its own process group so SIGTERM to the marksman
        // process can reach it via process.kill(-pid). Without this, killing
        // the parent leaves the Python child blocked on its readline() loop
        // (it would notice stdin EOF eventually, but only after the next
        // inference finishes — leaving zombies after restarts).
        detached: true,
      });
      // Make sure the Python child does not block Node's own exit.
      proc.unref();

      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let resolved = false;

      proc.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.event === "ready") {
            if (!resolved) {
              resolved = true;
              resolve();
            }
            continue;
          }
          if (msg.event === "fatal") {
            const err = new Error(`OmniParser sidecar fatal: ${msg.error}`);
            if (!resolved) {
              resolved = true;
              reject(err);
            }
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
            continue;
          }
          const id: string | undefined = msg.request_id;
          if (!id) continue;
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          if (msg.error) {
            pending.reject(new Error(String(msg.error)));
          } else if (Array.isArray(msg.elements)) {
            pending.resolve(normalize(msg.elements));
          } else {
            pending.reject(new Error("OmniParser response missing elements"));
          }
        }
      });

      proc.stderr.on("data", (chunk: string) => {
        process.stderr.write(`[omniparser] ${chunk}`);
      });

      proc.on("exit", (code) => {
        const err = new Error(`OmniParser sidecar exited (code ${code})`);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });

      this.proc = proc;
    });

    return this.ready;
  }

  async detect(screenshot: Buffer): Promise<DetectedElement[]> {
    await this.ensureReady();
    if (!this.proc) throw new Error("OmniParser sidecar not running");

    const id = randomUUID();
    const tmpDir = path.join(tmpdir(), "marksman-omni");
    mkdirSync(tmpDir, { recursive: true });
    const imagePath = path.join(tmpDir, `req-${id}.png`);
    writeFileSync(imagePath, screenshot);

    const proc = this.proc;
    return new Promise<DetectedElement[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ request_id: id, image_path: imagePath }) + "\n");
    });
  }
}

let client: OmniParserClient | null = null;

export async function detectViaOmniParser(
  screenshot: Buffer,
): Promise<DetectedElement[]> {
  if (!client) client = new OmniParserClient();
  return client.detect(screenshot);
}

// Make sure the Python sidecar dies with the Node parent. Without this, a
// graceful shutdown (SIGTERM from /reload-plugins) leaves the child stuck in
// its readline() loop, holding stale code in memory — accumulating zombie
// sidecars across restarts.
function killSidecar() {
  if (!client) return;
  // @ts-ignore — reaching into private state for the cleanup hook.
  const proc = client["proc"];
  if (proc && proc.pid) {
    try {
      // negative pid kills the whole process group (we spawned with detached:true).
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    killSidecar();
    process.exit(0);
  });
}
process.once("exit", killSidecar);

/**
 * Normalize a raw response (which may use varied field names from the Python
 * side) into our DetectedElement shape, and renumber labels sequentially.
 */
function normalize(raw: any[]): DetectedElement[] {
  return raw
    .map((el) => {
      const bbox = el.bbox ?? el.box;
      if (!bbox) return null;
      return {
        bbox: {
          x: Number(bbox.x ?? bbox[0]),
          y: Number(bbox.y ?? bbox[1]),
          w: Number(bbox.w ?? bbox.width ?? bbox[2]),
          h: Number(bbox.h ?? bbox.height ?? bbox[3]),
        },
        type: String(el.type ?? el.category ?? "element"),
        text: String(el.text ?? el.caption ?? el.content ?? "").trim(),
        label: 0,
      } as DetectedElement;
    })
    .filter((el): el is DetectedElement => el !== null)
    .map((el, i) => ({ ...el, label: i + 1 }));
}
