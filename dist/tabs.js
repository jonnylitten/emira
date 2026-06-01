/**
 * Owns the set of open browser tabs for a single BrowserContext. Tabs get a
 * monotonically increasing numeric id assigned at registration time — stable
 * for the marksman process lifetime, easy for an LLM to remember ("tab 2 is
 * the OAuth popup"). Closed tab ids are NOT recycled.
 *
 * Each tab owns its own label state — labels are scoped per-screenshot, and
 * each screenshot is per-tab, so two open tabs have independent label maps.
 *
 * Popups (target=_blank clicks, window.open, OAuth flows) are auto-registered
 * via the BrowserContext 'page' event — agent doesn't need to do anything
 * special to "see" the new tab.
 */
export class TabRegistry {
    tabs = new Map();
    activeId = null;
    nextId = 1;
    context;
    constructor(context) {
        this.context = context;
        // Auto-register any pages already in the context (the initial blank one
        // from launchPersistentContext).
        for (const page of context.pages()) {
            this.registerPage(page);
        }
        // Auto-register future pages — both programmatic ones from open() AND
        // popups created by the page itself (window.open, target=_blank).
        context.on("page", (page) => {
            this.registerPage(page);
        });
    }
    /**
     * Idempotent: if this Page is already tracked, return the existing state.
     * Otherwise mint a new tab id, register cleanup on close, and set active
     * if there's nothing else.
     */
    registerPage(page) {
        for (const state of this.tabs.values()) {
            if (state.page === page)
                return state;
        }
        const id = this.nextId++;
        const state = {
            id,
            page,
            labelMap: {},
            elements: [],
        };
        this.tabs.set(id, state);
        page.on("close", () => {
            this.tabs.delete(id);
            if (this.activeId === id) {
                // Pick the lowest remaining tab id as the new active, or null if
                // the registry is empty. The Marksman controller will lazily spawn
                // a fresh tab on the next action if needed.
                const remaining = Array.from(this.tabs.keys()).sort((a, b) => a - b);
                this.activeId = remaining[0] ?? null;
            }
        });
        if (this.activeId === null) {
            this.activeId = id;
        }
        return state;
    }
    getActive() {
        if (this.activeId === null) {
            throw new Error("No active tab. The browser context has no open pages — call open_tab to start one.");
        }
        const state = this.tabs.get(this.activeId);
        if (!state) {
            throw new Error(`Active tab id ${this.activeId} not in registry`);
        }
        return state;
    }
    getById(id) {
        const state = this.tabs.get(id);
        if (!state) {
            const open = Array.from(this.tabs.keys()).sort((a, b) => a - b);
            throw new Error(`Tab ${id} not found. Open tabs: ${open.length ? open.join(", ") : "(none)"}. Call list_tabs to inspect.`);
        }
        return state;
    }
    /** Resolve a tab — explicit id if given, otherwise the active tab. */
    get(tabId) {
        return tabId !== undefined ? this.getById(tabId) : this.getActive();
    }
    /**
     * Open a new tab and make it active. The Playwright 'page' event registers
     * it; we then look it up to return the new TabState. If the new tab should
     * navigate immediately, pass `url`.
     */
    async open(url, wait_ms) {
        const page = await this.context.newPage();
        // 'page' event has fired synchronously by now — find the state.
        let state;
        for (const s of this.tabs.values()) {
            if (s.page === page) {
                state = s;
                break;
            }
        }
        if (!state)
            state = this.registerPage(page);
        this.activeId = state.id;
        if (url) {
            await page
                .goto(url, { waitUntil: "networkidle", timeout: 15000 })
                .catch(async (err) => {
                if (/Timeout/i.test(err.message)) {
                    await page.goto(url, { waitUntil: "domcontentloaded" });
                }
                else
                    throw err;
            });
        }
        if (wait_ms)
            await page.waitForTimeout(wait_ms);
        return state;
    }
    switch(tabId) {
        const state = this.getById(tabId);
        this.activeId = tabId;
        return state;
    }
    /**
     * Close a tab (defaults to active). If it was the last tab, spawn a fresh
     * blank one so the marksman session is always usable.
     */
    async close(tabId) {
        const state = this.get(tabId);
        const closedId = state.id;
        await state.page.close();
        // 'close' handler runs here, removes from map, picks new active.
        if (this.tabs.size === 0) {
            // Don't leave the registry empty — open a blank tab so the next
            // action doesn't fail. activeId gets set by registerPage.
            await this.context.newPage();
        }
        return { closed_id: closedId, active_id: this.activeId };
    }
    async list() {
        const out = [];
        for (const [id, state] of this.tabs) {
            const title = await state.page.title().catch(() => "");
            out.push({
                id,
                url: state.page.url(),
                title,
                active: id === this.activeId,
            });
        }
        return out.sort((a, b) => a.id - b.id);
    }
    /** Ensure there's at least one tab. Called from getTabs() after construction. */
    async ensureAtLeastOne() {
        if (this.tabs.size === 0) {
            await this.context.newPage();
        }
    }
}
//# sourceMappingURL=tabs.js.map