import { chromium } from "playwright";
import { toPlaywrightProxy } from "./proxy.js";

class BrowserManager {
  constructor() {
    this.browser = null;
    this.browserUses = 0;
    this.lastHeaded = true;
  }

  async ensureBrowser({ headed }) {
    const shouldRelaunch = !this.browser || this.lastHeaded !== headed;
    if (!shouldRelaunch) return;

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.browser = await chromium.launch({ headless: !headed });
    this.browserUses = 0;
    this.lastHeaded = headed;
  }

  async newContext({ headed, maxUses, proxy }) {
    const configuredMaxUses = Math.max(1, Number(maxUses || 10));

    if (this.browser && this.browserUses >= configuredMaxUses) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserUses = 0;
    }

    await this.ensureBrowser({ headed: Boolean(headed) });
    this.browserUses += 1;

    const context = await this.browser.newContext({
      proxy: toPlaywrightProxy(proxy),
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 }
    });

    return context;
  }

  async closeAll() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserUses = 0;
    }
  }
}

export const browserManager = new BrowserManager();
