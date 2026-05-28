import { chromium } from "playwright";
let session = null;
export async function getPage() {
    if (session && !session.browser.isConnected()) {
        session = null;
    }
    if (!session) {
        const headless = process.env.MARKSMAN_HEADLESS !== "false";
        const browser = await chromium.launch({ headless });
        const page = await browser.newPage({
            viewport: { width: 1280, height: 800 },
        });
        session = { browser, page };
    }
    return session.page;
}
export async function closeBrowser() {
    if (session) {
        await session.browser.close().catch(() => { });
        session = null;
    }
}
//# sourceMappingURL=browser.js.map