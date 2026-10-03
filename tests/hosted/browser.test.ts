import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { buildHosted } from "../../src/surfaces/hosted/build.ts";
import relayWorker, { type RelayEnv } from "../../src/surfaces/hosted/relay.ts";
import { clickButton, launchBrowser, waitForText } from "../helpers/browser.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { startHostedStack, type HostedStack } from "../helpers/hosted_stack.ts";

/**
 * The shipped hosted book in a real Chromium: the built bundle, served with
 * the relay Worker in front of the real seal worker and a scripted model.
 * The player's Campaign lives only in the page's OPFS, with its git history.
 */

let dist = "";
let browser: Browser;
beforeAll(async () => {
  dist = await makeTempDir("nq-hosted-dist-");
  await buildHosted({ outDir: dist, minify: false });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await rmTempDir(dist);
});

let stack: HostedStack | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;
let context: BrowserContext | undefined;
afterEach(async () => {
  await context?.close();
  site?.stop(true);
  await stack?.stop();
  context = undefined;
  site = undefined;
  stack = undefined;
});

/** Cloudflare in miniature: the relay Worker with the built book as its assets. */
function serveSite(s: HostedStack, env: RelayEnv = s.env): string {
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) =>
      relayWorker.fetch(request, {
        ...env,
        ASSETS: {
          // single-page-application mode, as in wrangler.jsonc: unknown paths get the book
          async fetch(req) {
            const url = new URL(req.url);
            const file = Bun.file(path.join(dist, url.pathname === "/" ? "index.html" : url.pathname));
            return new Response((await file.exists()) ? file : Bun.file(path.join(dist, "index.html")));
          },
        },
      }),
  });
  // localhost is a secure context, which OPFS and WebCrypto require
  return `http://localhost:${site.port}/`;
}

async function opfsText(page: Page, file: string): Promise<string | null> {
  // the app may be writing the file right now, and OPFS refuses a read mid-write
  for (let attempt = 0; ; attempt++) {
    const got = await page.evaluate(async (p) => {
      let dir = await navigator.storage.getDirectory();
      const parts = p.split("/").filter(Boolean);
      try {
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return { text: await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text() };
      } catch (err) {
        return { busy: (err as Error).name === "NotReadableError" };
      }
    }, file);
    if ("text" in got) return got.text ?? null;
    if (!got.busy || attempt > 50) return null;
    await Bun.sleep(20);
  }
}

async function opfsList(page: Page, at: string): Promise<string[]> {
  return page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of p.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    } catch {
      return [];
    }
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  }, at);
}

test("a player starts an adventure, plays, reloads, and picks it up again — all in the browser", async () => {
  stack = await startHostedStack({
    steps: [
      (c) => {
        c.think("A roll for the gulls.");
        c.tool("roll", { n: 6, i: "the gulls scatter" });
      },
      (c) => {
        c.say("The gulls lift off the pilings ");
        c.say("and Mira Venn raises a hand in greeting.");
      },
    ],
  });
  const url = serveSite(stack);
  context = await browser.createBrowserContext();
  const page = await context.newPage();
  // desktop width: both leaves and the rail are on screen
  await page.setViewport({ width: 1280, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  // a quiet console: no errors, and no OMP stub reached by the hosted book
  const logged: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") errors.push(`${msg.type()}: ${msg.text()}`);
    else logged.push(msg.text());
  });

  // Home, then a new adventure from a bundled Seed Pack
  await page.goto(url);
  await waitForText(page, "Brinewatch");
  // a pack the repo keeps private never ships on the public site
  expect(await page.evaluate(() => document.body.innerText)).not.toContain("Avatar of Torment");
  // Home settings offer no context ceiling and no diagnostics
  await clickButton(page, "Settings");
  await waitForText(page, "Light hygiene every");
  const homeSettings = await page.evaluate(() => document.body.innerText.toLowerCase());
  expect(homeSettings).not.toContain("context ceiling");
  expect(homeSettings).not.toContain("debug logging");
  expect(homeSettings).not.toContain("log file");
  await page.keyboard.press("Escape");
  await page.goto(url);
  await waitForText(page, "Brinewatch");

  await clickButton(page, "Brinewatch");
  await page.waitForSelector("input");
  // the title field starts with the pack's name
  await page.click("input", { count: 3 });
  await page.type("input", "Salt and Coin");
  await clickButton(page, "BEGIN");
  await waitForText(page, "Mira Venn watches you from the Salt Lamp doorway.");

  // the book has no AI log, and its settings leaf hides the same fields
  expect(await page.evaluate(() => document.body.innerText.toLowerCase())).not.toContain("ai log");
  await clickButton(page, "SETTINGS");
  await waitForText(page, "Light hygiene every");
  const bookSettings = await page.evaluate(() => document.body.innerText.toLowerCase());
  expect(bookSettings).not.toContain("context ceiling");
  expect(bookSettings).not.toContain("debug logging");

  // a Turn: the model rolls through a tool, then streams its reply
  await page.evaluate(() => {
    // note whether the reply was revealed line by line (through the line mask)
    const w = window as unknown as { __masked?: boolean };
    const t = window as unknown as { __thinkMasked?: boolean };
    new MutationObserver(() => {
      if (document.querySelector(".story-block.gm .prose[style*='mask-image']")) w.__masked = true;
      if (document.querySelector(".scratch-above.is-live .think[style*='mask-image']")) t.__thinkMasked = true;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
  await page.type("textarea", "I walk to the dock.");
  await page.keyboard.press("Enter");
  await waitForText(page, "Mira Venn raises a hand in greeting.");
  // lines faded in, and once the Turn is over every line shows and the mask is gone
  await page.waitForFunction(() => {
    const el = document.querySelector(".story-block.gm.latest .prose") as HTMLElement | null;
    return !!el && !el.closest(".draft") && !el.style.getPropertyValue("mask-image") && !el.style.height;
  });
  expect(await page.evaluate(() => (window as unknown as { __masked?: boolean }).__masked)).toBe(true);
  // the live Scratch fades in the same way
  expect(await page.evaluate(() => (window as unknown as { __thinkMasked?: boolean }).__thinkMasked)).toBe(true);

  // the console shows what the prompt is built from, and what each call really cost
  expect(logged.some((l) => /^\[nq\] Game Master prompt ≈ [\d,]+ tokens/.test(l))).toBe(true);
  expect(logged).toContain("[nq] model call: 1,200 prompt tokens, 80 generated");

  // the Campaign lives in OPFS, git history and all
  const [slug] = await opfsList(page, "/nq/campaigns");
  expect(slug).toBeDefined();
  const campaign = `/nq/campaigns/${slug}`;
  const transcript = (await opfsText(page, `${campaign}/transcript.jsonl`)) ?? "";
  expect(transcript).toContain("I walk to the dock.");
  expect(transcript).toContain("The gulls lift off the pilings and Mira Venn raises a hand in greeting.");
  expect(await opfsText(page, `${campaign}/.git/HEAD`)).toContain("refs/heads/main");
  expect((await opfsList(page, `${campaign}/.git/objects`)).length).toBeGreaterThan(0);
  expect(await opfsText(page, `${campaign}/.nq/scratch.jsonl`)).toContain("the gulls scatter");

  // `nqExport()` in the console downloads the open Campaign for a look from outside
  const downloads = await makeTempDir("nq-export-");
  const cdp = await page.createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const said = await page.evaluate(() => (window as unknown as { nqExport: () => Promise<string> }).nqExport());
  expect(said).toContain("Saved nq-session-");
  let exported: { files: Record<string, string>; siteSettings: string | null } | undefined;
  for (let i = 0; i < 100 && !exported; i++) {
    const done = (await readdir(downloads)).find((f) => f.endsWith(".json"));
    if (done) exported = JSON.parse(await readFile(path.join(downloads, done), "utf8"));
    else await Bun.sleep(20);
  }
  expect(exported?.files["transcript.jsonl"]).toContain("I walk to the dock.");
  expect(exported?.files[".nq/scratch.jsonl"]).toContain("the gulls scatter");
  expect(Object.keys(exported?.files ?? {}).some((f) => f.startsWith(".git/"))).toBe(false);
  await rmTempDir(downloads);

  // nothing readable crossed the relay
  const wire = [...stack.seen.requests, ...stack.seen.responses].join("\n");
  expect(wire).not.toContain("I walk to the dock.");
  expect(wire).not.toContain("Mira Venn raises a hand");

  // the address names the adventure, so a reload goes straight back into it
  expect(new URL(page.url()).pathname).toMatch(/^\/play\/salt-and-coin-[0-9a-f]{8}$/);
  const adventureUrl = page.url();
  stack.llama.push((c) => c.say("Mira pours you a cup of salt tea."));
  await page.reload();
  await waitForText(page, "Mira Venn raises a hand in greeting.");
  expect(page.url()).toBe(adventureUrl);

  // Contents goes Home, and Back returns to the adventure
  await clickButton(page, "Contents");
  await waitForText(page, "New adventure");
  await page.waitForFunction(() => window.location.pathname === "/");
  await page.goBack();
  await waitForText(page, "Mira Venn raises a hand in greeting.");
  expect(page.url()).toBe(adventureUrl);

  // an address for an adventure this browser does not have lands on Home
  const stranger = await context.newPage();
  await stranger.setViewport({ width: 1280, height: 900 });
  await stranger.goto(`${url}play/some-other-tale-0badc0de`);
  await waitForText(stranger, "That adventure is not in this browser.");
  await stranger.waitForFunction(() => window.location.pathname === "/");
  await stranger.close();
  await page.waitForSelector("textarea");
  await page.type("textarea", "I sit at the bar.");
  await page.keyboard.press("Enter");
  await waitForText(page, "Mira pours you a cup of salt tea.");
  const resumed = stack.llama.calls.at(-1)!;
  const history = resumed.messages.map((m) => JSON.stringify(m.content)).join("\n");
  expect(history).toContain("I walk to the dock.");
  expect(resumed.prompt).toBe("I sit at the bar.");

  expect(errors).toEqual([]);
}, 30_000);

test("the page shows at a glance whether the Game Master answers, and offers a reload when the owner's computer is back", async () => {
  stack = await startHostedStack({ steps: [(c) => c.say("Mira nods.")] });
  // Cloudflare's tunnel to the owner's computer, which can go away
  let away = false;
  const upstream = stack.env.RUNPOD_UPSTREAM!;
  const local: RelayEnv = {
    GM_BACKEND: "local",
    LOCAL_GM: {
      async fetch(input, init) {
        if (away) throw new Error("tunnel down");
        return fetch(`${upstream}${new URL(input).pathname}`, init);
      },
    },
    LOCAL_GM_TOKEN: "secret",
    LOCAL_WORKER_KEY: stack.env.WORKER_KEY!,
  };
  const url = serveSite(stack, local);
  context = await browser.createBrowserContext();
  const page = await context.newPage();
  const badge = async (state: string, text: string) => {
    await page.waitForFunction(
      (s, t) => {
        const el = document.getElementById("nq-gm-status");
        return el?.dataset.state === s && (el.textContent ?? "").includes(t);
      },
      { timeout: 10_000 },
      state,
      text,
    );
  };

  await page.goto(url);
  await waitForText(page, "Brinewatch");
  await badge("online", "Game Master online");

  // the computer goes away: a tap checks now, without waiting for the next poll
  away = true;
  await page.click("#nq-gm-status");
  await badge("offline", "Game Master offline");
  away = false;
  await page.click("#nq-gm-status");
  await badge("online", "Game Master online");

  // a page opened while it is away says so instead of only failing to start
  away = true;
  await page.goto(url);
  await waitForText(page, "could not start");
  await badge("offline", "Game Master offline");
  away = false;
  await page.click("#nq-gm-status");
  await badge("online", "Game Master is back · tap to reload");
  await page.click("#nq-gm-status");
  await waitForText(page, "Brinewatch");
  await badge("online", "Game Master online");
});

test("on the OpenRouter backup the badge says so, and that the main Game Master is back", async () => {
  stack = await startHostedStack({ steps: [] });
  let away = true;
  const upstream = stack.env.RUNPOD_UPSTREAM!;
  const url = serveSite(stack, {
    GM_BACKEND: "local",
    LOCAL_GM: {
      async fetch(input, init) {
        if (away) throw new Error("tunnel down");
        return fetch(`${upstream}${new URL(input).pathname}`, init);
      },
    },
    LOCAL_GM_TOKEN: "secret",
    LOCAL_WORKER_KEY: stack.env.WORKER_KEY!,
    OPENROUTER_API_KEY: "or-key",
  });
  context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(url);
  await waitForText(page, "Brinewatch");
  await page.waitForFunction(() => {
    const el = document.getElementById("nq-gm-status");
    return el?.dataset.state === "backup" && (el.textContent ?? "").includes("the main one is offline");
  });
  away = false;
  await page.click("#nq-gm-status");
  await page.waitForFunction(() =>
    (document.getElementById("nq-gm-status")?.textContent ?? "").includes("the main one is back, tap to reload"),
  );
});
