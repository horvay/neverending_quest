/**
 * The hosted book's entry: mount the player's Campaigns from OPFS, build the
 * in-page "server" (Home, Play Loop, routes) around the sealed Game Master,
 * route the book's `/api/…` fetches to it, then start the unchanged book.
 */
import "./globals.ts";
import { createHostedApp } from "../app.ts";
import { connectGameMaster } from "../../../agent/browser/connect.ts";
import { mountStatusBadge } from "./status_badge.ts";
import { mountOpfs, promises as vfs } from "./vfs.ts";

const DATA_DIR = "/nq";
const PACKS_DIR = "/packs";

async function boot(): Promise<void> {
  // every module has loaded; an OMP stub called from here on is a real gap
  (globalThis as { __nqBooted?: boolean }).__nqBooted = true;
  const realFetch = window.fetch.bind(window);
  const relay = `${location.origin}/relay`;
  // shown before anything else, so a page that cannot start still says why and when it can
  const badge = mountStatusBadge({ relay, fetch: realFetch, using: "none" });
  // a relay call that fails rechecks the badge at once
  const relayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const res = await realFetch(input, init);
      if (res.status >= 500) badge.recheck();
      return res;
    } catch (err) {
      badge.recheck();
      throw err;
    }
  }) as typeof fetch;
  await mountOpfs();
  const gameMaster = await connectGameMaster({ relay, fetch: relayFetch });
  badge.setUsing(gameMaster.dialect === "openai" ? "openrouter" : "sealed");
  const app = await createHostedApp({
    agent: {
      ...gameMaster,
      // developer view only: what the Game Master's prompt is built from
      onPromptBreakdown: (parts) => {
        const total = parts.reduce((n, p) => n + p.tokens, 0);
        console.groupCollapsed(`[nq] Game Master prompt ≈ ${total.toLocaleString()} tokens (estimated, chars / 4)`);
        console.table(parts);
        console.groupEnd();
      },
      onUsage: ({ promptTokens, completionTokens, cachedTokens, cost }) => {
        const cached = cachedTokens !== undefined ? ` (${cachedTokens.toLocaleString()} cached)` : "";
        const paid = cost !== undefined ? `, $${cost.toFixed(5)}` : "";
        console.info(
          `[nq] model call: ${promptTokens.toLocaleString()} prompt tokens${cached}, ${completionTokens.toLocaleString()} generated${paid}`,
        );
      },
    },
    dataDir: DATA_DIR,
    packsDir: PACKS_DIR,
  });
  let askedToPersist = false;
  const routed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }
    const res = await app.handler(request);
    // browsers may evict site data; ask to keep it once there is a Campaign
    if (!askedToPersist && url.pathname === "/api/campaigns" && res.ok) {
      askedToPersist = true;
      void navigator.storage?.persist?.().catch(() => false);
    }
    return res;
  };
  window.fetch = Object.assign(routed, { preconnect: realFetch.preconnect }) as typeof fetch;
  (window as unknown as { __nq?: unknown }).__nq = { app };
  // for the developer console: `nqExport()` downloads the open Campaign as JSON
  (window as unknown as { nqExport?: () => Promise<string> }).nqExport = () => exportOpenCampaign(app);
  await import("../../web/client/client.tsx");
}

void boot().catch((err) => {
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Neverending Quest could not start: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.error(err);
});

/**
 * Everything needed to look at a play session from outside the browser: every
 * text file of the open Campaign (transcript, Scratch, memory, seed, play
 * state) plus the site settings, as one downloaded JSON file. Git objects,
 * pictures and sessions are left out.
 */
async function exportOpenCampaign(app: Awaited<ReturnType<typeof createHostedApp>>): Promise<string> {
  const play = app.home.play;
  if (!play) return "Open a Campaign first, then run nqExport() again.";
  const root = play.api.campaignPath;
  // read the app's own copy: OPFS refuses reads of a file mid-write
  const files: Record<string, string> = {};
  const walk = async (dir: string, at: string): Promise<void> => {
    for (const entry of (await vfs.readdir(dir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>) {
      const p = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "illustrations" || entry.name === "sessions") continue;
        await walk(`${dir}/${entry.name}`, p);
      } else {
        files[p] = String(await vfs.readFile(`${dir}/${entry.name}`, "utf8"));
      }
    }
  };
  await walk(root, "");
  let settings: string | null = null;
  try {
    settings = String(await vfs.readFile(`${DATA_DIR}/config.toml`, "utf8"));
  } catch {
    // no saved settings yet
  }
  const dump = {
    exportedAt: new Date().toISOString(),
    campaignPath: root,
    siteSettings: settings,
    contextUsage: play.loop.contextUsage ?? null,
    files,
  };
  const name = `nq-session-${root.split("/").pop()}-${Date.now()}.json`;
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" })),
    download: name,
  });
  link.click();
  return `Saved ${name} (${Object.keys(files).length} files) to your downloads.`;
}

