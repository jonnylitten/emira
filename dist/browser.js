import { chromium } from "playwright";
import { homedir } from "node:os";
import path from "node:path";
import { rm, mkdir } from "node:fs/promises";
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
export async function getPage() {
    if (session && session.context.pages().length === 0) {
        // Persistent context can survive but lose all its pages if everything is
        // closed externally — re-open one rather than throwing.
        session.page = await session.context.newPage();
    }
    if (!session) {
        const headless = process.env.MARKSMAN_HEADLESS !== "false";
        const profileDir = resolveProfileDir();
        await mkdir(profileDir, { recursive: true });
        // launchPersistentContext combines launch() + newContext() and writes
        // session state into profileDir. Slightly slower to start (~1s vs ~300ms)
        // because it replays the on-disk state, but unlocks log-in-once flows.
        const context = await chromium.launchPersistentContext(profileDir, {
            headless,
            viewport: { width: 1280, height: 800 },
        });
        const page = context.pages()[0] ??
            (await context.newPage());
        session = { context, page, profileDir };
    }
    return session.page;
}
export async function closeBrowser() {
    if (session) {
        await session.context.close().catch(() => { });
        session = null;
    }
}
/**
 * Wipe the persisted profile (cookies, localStorage, etc.) and restart with
 * a fresh context. The next getPage() call will see a clean browser.
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