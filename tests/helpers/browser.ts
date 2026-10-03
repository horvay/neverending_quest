import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * A real headless Chromium for tests that need browser-only APIs (OPFS,
 * WebCrypto X25519). Resolved the way OMP's browser tool does it: a system
 * Chromium, else PUPPETEER_EXECUTABLE_PATH, else a one-time download.
 */
const SYSTEM_CHROMIUM = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function chromiumPath(): Promise<string> {
  const system = SYSTEM_CHROMIUM.find((p) => existsSync(p));
  if (system) return system;
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const browsers = await import("@puppeteer/browsers");
  const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
  const platform = browsers.detectBrowserPlatform();
  if (!platform) throw new Error("No Chromium for this platform; set PUPPETEER_EXECUTABLE_PATH");
  // os.homedir() is the real home even under the test sandbox, so the download is cached once
  const cacheDir = path.join(os.homedir(), ".cache", "nq-test-chromium");
  const buildId = await browsers.resolveBuildId(
    browsers.Browser.CHROME,
    platform,
    PUPPETEER_REVISIONS.chrome,
  );
  const executablePath = browsers.computeExecutablePath({
    browser: browsers.Browser.CHROME,
    buildId,
    cacheDir,
    platform,
  });
  if (!existsSync(executablePath)) {
    await browsers.install({ browser: browsers.Browser.CHROME, buildId, cacheDir, platform });
  }
  return executablePath;
}

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
}

/**
 * Click the button labelled `text` (any case, as CSS may capitalise): an exact
 * label first, else the first button whose text contains it.
 */
export async function clickButton(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate((t) => {
    const want = t.toLowerCase();
    const buttons = Array.from(document.querySelectorAll("button"));
    const label = (b: Element) => (b.textContent ?? "").trim().toLowerCase();
    const button = (buttons.find((b) => label(b) === want) ??
      buttons.find((b) => label(b).includes(want))) as HTMLElement | undefined;
    button?.click();
    return Boolean(button);
  }, text);
  if (!clicked) throw new Error(`no button with "${text}"`);
}

/** Wait until the page's text contains `text`, in any case (CSS may capitalise). */
export async function waitForText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t),
    { timeout },
    text.toLowerCase(),
  );
}
