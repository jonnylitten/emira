import { chromium } from "playwright";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { rm, mkdir, mkdtemp, readdir, stat, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { TabRegistry } from "./tabs.js";
let session = null;
/**
 * Resolve the Chromium user-data directory.
 *
 * Priority:
 *   1. MARKSMAN_PROFILE_DIR (explicit override)
 *   2. $CLAUDE_PLUGIN_DATA/profile/ (plugin mode — survives plugin updates)
 *   3. ~/.cache/marksman/profile/ (standalone / dev mode)
 *
 * Cookies, localStorage, IndexedDB, and downloaded files live here and survive
 * across marksman process restarts so authenticated automation tasks don't
 * need to log in fresh every session.
 */
function resolveProfileDir() {
    const explicit = process.env.MARKSMAN_PROFILE_DIR;
    if (explicit)
        return explicit;
    const pluginData = process.env.CLAUDE_PLUGIN_DATA;
    if (pluginData)
        return path.join(pluginData, "profile");
    return path.join(homedir(), ".cache", "marksman", "profile");
}
/** Parse MARKSMAN_VIEWPORT ("1440x900"). Falls back to a roomy default. */
function resolveViewport() {
    const m = process.env.MARKSMAN_VIEWPORT?.trim().match(/^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i);
    if (m)
        return { width: Number(m[1]), height: Number(m[2]) };
    return { width: 1440, height: 900 };
}
/**
 * Whether to reuse the on-disk profile. Off by default.
 *
 * A persistent profile holds live logged-in sessions, which turns any other
 * weakness into account access. So persistence is opt-in: set
 * MARKSMAN_PERSIST_PROFILE=1 when you genuinely need to stay logged in across
 * runs (and tighten everything else when you do). Otherwise each session gets a
 * throwaway profile that is deleted on shutdown.
 */
function persistProfile() {
    return /^(1|true)$/i.test(process.env.MARKSMAN_PERSIST_PROFILE ?? "");
}
export async function getTabs() {
    if (!session) {
        const headless = process.env.MARKSMAN_HEADLESS !== "false";
        const executablePath = process.env.MARKSMAN_EXECUTABLE_PATH?.trim() || undefined;
        const ephemeral = !persistProfile();
        if (ephemeral)
            await sweepStaleProfiles();
        const profileDir = ephemeral
            ? await mkdtemp(path.join(tmpdir(), "marksman-profile-"))
            : resolveProfileDir();
        if (!ephemeral) {
            await mkdir(profileDir, { recursive: true, mode: 0o700 });
            // mkdir's mode only applies at creation, so profiles made before this was
            // tightened would keep their old permissions. This dir holds live logged-in
            // sessions, so enforce owner-only every launch.
            await chmod(profileDir, 0o700).catch(() => { });
        }
        const context = await chromium.launchPersistentContext(profileDir, {
            headless,
            viewport: resolveViewport(),
            // Playwright's default signal handling tears the process down on
            // SIGTERM/SIGINT before our own shutdown can finish, which skipped
            // temp-profile cleanup entirely. Own the lifecycle ourselves.
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            ...(executablePath ? { executablePath } : {}),
        });
        const tabs = new TabRegistry(context);
        await tabs.ensureAtLeastOne();
        session = { context, tabs, profileDir, ephemeral };
    }
    return session.tabs;
}
/**
 * Back-compat shim: returns the active tab's Page. Use `getTabs()` when you
 * need tab management; `getPage()` when you just need the active page.
 */
export async function getPage() {
    const tabs = await getTabs();
    return tabs.getActive().page;
}
export async function closeBrowser() {
    if (session) {
        const { profileDir, ephemeral } = session;
        await session.context.close().catch(() => { });
        session = null;
        // Throwaway profiles carry whatever the run touched. Don't leave them behind.
        if (ephemeral)
            await removeProfile(profileDir);
    }
}
/**
 * Remove a throwaway profile. Chromium helper processes can still be writing
 * for a moment after context.close() resolves, so a single rm can lose the
 * race; retry briefly, and say so on stderr rather than failing silently.
 */
async function removeProfile(dir) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await rm(dir, { recursive: true, force: true, maxRetries: 3 });
            if (!existsSync(dir))
                return;
        }
        catch {
            // fall through to retry
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    if (existsSync(dir)) {
        console.error(`[marksman] could not remove temp profile ${dir}`);
    }
}
/**
 * Delete abandoned throwaway profiles from previous runs.
 *
 * Exit handlers are not guaranteed (SIGKILL, crashes, a killed terminal), so
 * cleanup cannot depend on shutdown alone. Anything older than an hour is not
 * an active session, so it is safe to remove.
 */
async function sweepStaleProfiles() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    try {
        const entries = await readdir(tmpdir(), { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory() || !e.name.startsWith("marksman-profile-"))
                continue;
            const full = path.join(tmpdir(), e.name);
            try {
                if ((await stat(full)).mtimeMs < cutoff) {
                    await rm(full, { recursive: true, force: true });
                }
            }
            catch {
                // another process may own it; skip
            }
        }
    }
    catch {
        // sweeping is best-effort
    }
}
/**
 * Returns the active BrowserContext. Cookies, storage, and other context-level
 * state operations go through this. Lazily initializes the session if needed.
 */
export async function getContext() {
    await getTabs();
    return session.context;
}
/**
 * Wipe the persisted profile (cookies, localStorage, etc.) and restart with
 * a fresh context. The next getTabs() call will see a clean browser.
 */
export async function clearProfile() {
    const profileDir = session?.profileDir ?? resolveProfileDir();
    await closeBrowser();
    await rm(profileDir, { recursive: true, force: true });
    return { profileDir };
}
export function getProfileDir() {
    return session?.profileDir ?? resolveProfileDir();
}
//# sourceMappingURL=browser.js.map