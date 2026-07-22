// Central security policy. One declared set, checked at both surfaces.
//
// Escalation is enforced inside the controller methods rather than per handler,
// so the MCP path and the HTTP path are covered by the same declaration and a
// newly added tool cannot silently skip the check.
import path from "node:path";
import { realpathSync } from "node:fs";

/** A request refused by policy, not a bug. Surfaces as 400, not 500. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Tools that can exfiltrate live session state or run arbitrary code. */
export const ESCALATED_TOOLS = new Set([
  "run_javascript",
  "upload_at_label",
  "get_cookies",
  "set_cookie",
  "clear_cookies",
]);

/** HTTP endpoints mapping to the same policy, for early rejection with a 403. */
export const ESCALATED_ENDPOINTS = new Set([
  "/run_javascript",
  "/upload",
  "/get_cookies",
  "/set_cookie",
  "/clear_cookies",
]);

export function escalationEnabled(): boolean {
  return /^(1|true)$/i.test(process.env.MARKSMAN_ALLOW_ESCALATED ?? "");
}

/**
 * The failure has to teach the design, not just deny. A user who hits this
 * should understand why the gate exists without filing a bug.
 */
export function escalationError(tool: string): string {
  return (
    `${tool} is disabled. Set MARKSMAN_ALLOW_ESCALATED=1 to enable. ` +
    `This tool is gated because page content reaches the agent's context, so an ` +
    `injected page could invoke it against a browser holding your live sessions. ` +
    `Enabling it is reasonable when you are deliberately driving a target you trust. ` +
    `See README "Security and threat model".`
  );
}

export function assertEscalationAllowed(tool: string): void {
  if (!escalationEnabled()) throw new PolicyError(escalationError(tool));
}

/**
 * Restrict navigation to http(s) and block link-local / cloud metadata.
 *
 * Best-effort by construction: DNS can resolve a public name to a private
 * address, so this removes the trivial cases rather than solving SSRF. Stated
 * as such in the threat model rather than implied to be complete.
 */
export function assertNavigable(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PolicyError(`not a valid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new PolicyError(
      `scheme not allowed: ${u.protocol} (only http and https can be navigated; ` +
        `this blocks local file reads via file:// and similar)`,
    );
  }
  if (/^(169\.254\.|::ffff:169\.254\.)/.test(u.hostname) || u.hostname === "metadata.google.internal") {
    throw new PolicyError(`blocked host: ${u.hostname} (link-local / cloud metadata)`);
  }
  const allowed = process.env.MARKSMAN_ALLOWED_HOSTS?.trim();
  if (allowed) {
    const list = allowed.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!list.includes(u.hostname.toLowerCase())) {
      throw new PolicyError(
        `host not in MARKSMAN_ALLOWED_HOSTS: ${u.hostname} (allowed: ${list.join(", ")})`,
      );
    }
  }
  return u.toString();
}

/**
 * Confine uploads to a designated root.
 *
 * Unset means uploads are disabled: without this, a page with an upload form
 * plus an injected instruction is an arbitrary local file read. Symlinks are
 * resolved before the containment check so they cannot escape the root.
 */
export function assertUploadPath(requested: string): string {
  const root = process.env.MARKSMAN_UPLOAD_ROOT?.trim();
  if (!root) {
    throw new PolicyError(
      `file upload is disabled. Set MARKSMAN_UPLOAD_ROOT to a directory to enable it ` +
        `(for example the folder holding the files you intend to upload). Uploads are ` +
        `confined to that directory because an untrusted page could otherwise induce ` +
        `an upload of any file on this machine. See README "Security and threat model".`,
    );
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(root));
  } catch {
    throw new PolicyError(`MARKSMAN_UPLOAD_ROOT does not exist: ${root}`);
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(path.resolve(requested));
  } catch {
    throw new PolicyError(`upload file not found: ${requested}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new PolicyError(
      `upload path is outside MARKSMAN_UPLOAD_ROOT: ${requested} resolves to ` +
        `${realTarget}, which is not inside ${realRoot}`,
    );
  }
  return realTarget;
}

/**
 * Mark page-derived text as data, not instructions.
 *
 * A mitigation, not a fix: a sufficiently clever page can discuss the fence.
 * It costs nothing and makes the trust boundary explicit in the transcript.
 */
export function fencePageContent(text: string, src: string): string {
  return `<untrusted-page-content src="${src}">\n${text}\n</untrusted-page-content>`;
}
