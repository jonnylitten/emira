import { chromium, type BrowserContext, type Page } from "playwright";
import { homedir } from "node:os";
import path from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { TabRegistry } from "./tabs.js";

interface Session {
  context: BrowserContext;
  tabs: TabRegistry;
  profileDir: string;
}

let session: Session | null = null;

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
function resolveProfileDir(): string {
  const explicit = process.env.MARKSMAN_PROFILE_DIR;
  if (explicit) return explicit;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, "profile");

  return path.join(homedir(), ".cache", "marksman", "profile");
}

export async function getTabs(): Promise<TabRegistry> {
  if (!session) {
    const headless = process.env.MARKSMAN_HEADLESS !== "false";
    const profileDir = resolveProfileDir();
    await mkdir(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 800 },
    });
    const tabs = new TabRegistry(context);
    await tabs.ensureAtLeastOne();
    session = { context, tabs, profileDir };
  }
  return session.tabs;
}

/**
 * Back-compat shim: returns the active tab's Page. Use `getTabs()` when you
 * need tab management; `getPage()` when you just need the active page.
 */
export async function getPage(): Promise<Page> {
  const tabs = await getTabs();
  return tabs.getActive().page;
}

export async function closeBrowser(): Promise<void> {
  if (session) {
    await session.context.close().catch(() => {});
    session = null;
  }
}

/**
 * Returns the active BrowserContext. Cookies, storage, and other context-level
 * state operations go through this. Lazily initializes the session if needed.
 */
export async function getContext(): Promise<BrowserContext> {
  await getTabs();
  return session!.context;
}

/**
 * Wipe the persisted profile (cookies, localStorage, etc.) and restart with
 * a fresh context. The next getTabs() call will see a clean browser.
 */
export async function clearProfile(): Promise<{ profileDir: string }> {
  const profileDir = session?.profileDir ?? resolveProfileDir();
  await closeBrowser();
  await rm(profileDir, { recursive: true, force: true });
  return { profileDir };
}

export function getProfileDir(): string {
  return session?.profileDir ?? resolveProfileDir();
}
