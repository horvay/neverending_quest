import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listCampaignHistory } from "../../src/campaign/history.ts";
import { readScratch } from "../../src/campaign/scratch.ts";
import { readTranscript } from "../../src/campaign/transcript.ts";
import { createHostedApp, type HostedApp } from "../../src/surfaces/hosted/app.ts";
import { SESSION_TOOL_NAMES } from "../../src/play/sandbox.ts";
import type { LlamaCall } from "../helpers/fake_llama.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { startHostedStack, type HostedStack } from "../helpers/hosted_stack.ts";

/**
 * The hosted book's whole stack below the page, driven through the same HTTP
 * routes the book calls: Home → Play Loop → hosted agent → browser seal
 * client → Cloudflare relay → real GPU seal worker → scripted llama-server.
 * Only the model is fake. The Campaign lands on disk here (OPFS in the
 * browser build), with its git history.
 */

const PACKS = path.join(import.meta.dir, "../../packs");
const ORIGIN = "http://nq.hosted";

type Harness = {
  app: HostedApp;
  stack: HostedStack;
  dir: string;
  events: Array<Record<string, unknown>>;
  stopEvents?: () => void;
};
let h: Harness | undefined;

afterEach(async () => {
  if (!h) return;
  h.stopEvents?.();
  await h.app.home.leave().catch(() => {});
  await h.app.dispose();
  await h.stack.stop();
  await rmTempDir(h.dir);
  h = undefined;
});

async function call(method: string, route: string, body?: unknown): Promise<Response> {
  return h!.app.handler(
    new Request(`${ORIGIN}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

/** A post the book only offers while idle: retried through the Turn's busy window. */
async function whenIdle(route: string, body?: unknown): Promise<Response> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await call("POST", route, body);
    if (res.status !== 409 || Date.now() > deadline) return res;
    await Bun.sleep(5);
  }
}

/** Follow /api/events as the book does. */
async function followEvents(): Promise<void> {
  const res = await call("GET", "/api/events");
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let stopped = false;
  h!.stopEvents = () => {
    stopped = true;
    void reader.cancel().catch(() => {});
  };
  void (async () => {
    while (!stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) h!.events.push(JSON.parse(line));
      }
    }
  })();
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const got = await probe();
    if (got !== undefined && got !== false) return got as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const endedTurns = () => h!.events.filter((e) => e.type === "turn_ended");
const endedHygiene = () => h!.events.filter((e) => e.type === "hygiene_ended");

function lastAssistantPrefill(c: LlamaCall) {
  const last = c.messages.at(-1);
  return last?.role === "assistant" ? last.reasoning_content : undefined;
}

test("a hosted Campaign is born, played with tools, kept by Memory Hygiene, and resumed", async () => {
  const stack = await startHostedStack({
    steps: [
      // Turn 1, round 1: look Mira up and roll for the stake
      (c) => {
        c.think("Does Mira spot the coin?");
        c.tool("read", { path: "dossiers/mira-venn.md", i: "recall Mira" });
        c.tool("roll", { n: 20, i: "Mira notices the coin" });
      },
      // Turn 1, round 2: answer with what the tools returned
      (c) => {
        const [dossier, roll] = c.toolResults;
        c.think(`She watches hands. Rolled ${roll!.text}.`);
        c.say(dossier!.text.includes("Watches hands") ? "Mira's eyes drop to your hand. " : "?");
        c.say("She slides the coin back without a word.");
      },
      // Memory Hygiene: record the favor in her dossier
      (c) => {
        c.tool("edit", {
          path: "dossiers/mira-venn.md",
          old_string: "Feeds dock runners on tab.",
          new_string: "Feeds dock runners on tab. Owes the player one quiet favor.",
          i: "record the favor",
        });
      },
      (c) => c.say("Memory updated."),
    ],
  });
  const dir = await makeTempDir("nq-hosted-");
  const app = await createHostedApp({
    agent: { transport: stack.sealedFetch(), sleep: async () => {} },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  h = { app, stack, dir, events: [] };

  // Home: one fixed Game Master, so no sign-in or Model to choose; the Seed Packs are offered
  const home = (await (await call("GET", "/api/home")).json()) as {
    signedIn: { provider: string; model: string } | null;
    choosesGameMaster: boolean;
    packs: Array<{ id: string; name: string }>;
  };
  expect(home.signedIn?.provider).toBe("Neverending Quest");
  // which model plays, and its thinking level, are not shown to players
  expect(home.signedIn?.model).toBeUndefined();
  expect(home.choosesGameMaster).toBe(false);
  const signIn = await call("POST", "/api/login", { provider: "Grok" });
  expect(signIn.status).toBe(409);

  // the public book fixes a 30k context ceiling and has no diagnostics
  const settings = (await (await call("GET", "/api/home")).json()) as {
    settings: { compactCeilingTokens: number; debug: boolean; logPath: string };
    fixedSettings: string[];
    diagnostics: boolean;
  };
  expect(settings.settings).toMatchObject({ compactCeilingTokens: 30_000, compactSeedPercent: 70 });
  expect(settings.fixedSettings.sort()).toEqual([
    "compactCeilingTokens",
    "compactSeedPercent",
    "debug",
    "logPath",
    "maxTokens",
    "model",
  ]);
  expect(settings.diagnostics).toBe(false);
  const tried = (await (
    await call("POST", "/api/settings", {
      ...settings.settings,
      compactCeilingTokens: 200_000,
      debug: true,
      logPath: "/tmp/nq.log",
      hygieneN: 7,
      reasoning: "medium",
    })
  ).json()) as typeof settings;
  expect(tried.settings).toMatchObject({ compactCeilingTokens: 30_000, debug: false, logPath: "", hygieneN: 7 });
  const brinewatch = home.packs.find((p) => p.name === "Brinewatch");
  expect(brinewatch).toBeDefined();

  // New adventure
  const born = await call("POST", "/api/campaigns", { pack: brinewatch!.id, title: "Salt and Coin" });
  expect(born.status).toBe(201);
  const { id } = (await born.json()) as { id: string };
  const campaign = app.home.play!.api.campaignPath;
  await followEvents();

  // Turn 1: tools run for real against the Campaign folder
  expect((await call("POST", "/api/turn", { text: "I slip Mira a silver coin." })).status).toBe(202);
  await waitFor(() => endedTurns().length === 1, "turn 1");
  expect(endedTurns()[0]).toMatchObject({ outcome: "success" });
  const prose = "Mira's eyes drop to your hand. She slides the coin back without a word.";
  const rows = await readTranscript(campaign);
  expect(rows.at(-2)).toMatchObject({ role: "player", text: "I slip Mira a silver coin." });
  expect(rows.at(-1)).toMatchObject({ role: "gm", text: prose });

  // the book saw prose stream and the roll, with the stake from the tool intent
  expect(h.events.some((e) => e.type === "prose_delta")).toBe(true);
  const roll = h.events.find((e) => e.type === "roll") as { n: number; value: number; reason?: string };
  expect(roll).toMatchObject({ n: 20, reason: "Mira notices the coin" });
  expect(roll.value).toBeGreaterThanOrEqual(1);

  // Scratch kept the thinking (the latest round's, as with OMP) and both tool calls
  const [scratch] = await readScratch(campaign);
  expect(scratch?.thinking).toContain("She watches hands.");
  expect(scratch?.tools.map((t) => t.name)).toEqual(["read", "roll"]);

  // requests were shaped as for a llama.cpp provider: prefill only opens a Turn
  const [first, second] = stack.llama.calls;
  expect(first!.body).toMatchObject({
    // the player's reasoning setting reaches Qwen3.8's template, which would default to xhigh
    reasoning_effort: "medium",
    chat_template_kwargs: { reasoning_effort: "medium" },
    continue_final_message: "reasoning_content",
    add_generation_prompt: false,
    enable_thinking: true,
    stream: true,
  });
  // thinking starts from the player's words, capped for the rented GPU
  expect(lastAssistantPrefill(first!)).toBe("First, exactly what the player just said or did:");
  expect(first!.body.reasoning_budget_tokens).toBe(1_000);
  // every tool the session may ever use, so the engine keeps its prompt cache
  // across Memory Hygiene; each pass is limited when it calls one
  expect([...first!.toolNames].sort()).toEqual([...SESSION_TOOL_NAMES].sort());
  expect(second!.body.continue_final_message).toBeUndefined();
  expect(first!.messages[0]!.role).toBe("system");
  expect(String(first!.messages[0]!.content)).toContain("Pinned Campaign memory");

  // Memory Hygiene may write, sees the same tool schemas, and leaves play history clean
  expect((await whenIdle("/api/hygiene", { mode: "light" })).status).toBe(202);
  await waitFor(() => endedHygiene().length === 1, "hygiene");
  expect(endedHygiene()[0]).toMatchObject({ ok: true });
  const hygieneCall = stack.llama.calls[2]!;
  expect(hygieneCall.toolNames).toEqual(first!.toolNames);
  expect(await readFile(path.join(campaign, "dossiers/mira-venn.md"), "utf8")).toContain(
    "Owes the player one quiet favor.",
  );

  stack.llama.push((c) => c.say("The fog lifts over Grey Spit."));
  expect((await whenIdle("/api/turn", { text: "I step outside." })).status).toBe(202);
  await waitFor(() => endedTurns().length === 2, "turn 2");
  const turn2 = stack.llama.calls[4]!;
  expect(turn2.toolNames).toEqual(first!.toolNames);
  const turn2Users = turn2.messages.filter((m) => m.role === "user").map((m) => String(m.content));
  expect(turn2Users).toEqual(["I slip Mira a silver coin.", "I step outside."]);

  // every step is in the Campaign's git history
  // the book's own settings leaf cannot raise the ceiling either
  const play = (await (
    await whenIdle("/api/settings/play", { compactCeilingTokens: 90_000, debug: true, hygieneN: 8 })
  ).json()) as { settings: { compactCeilingTokens: number; debug: boolean; hygieneN: number } };
  expect(play.settings).toMatchObject({ compactCeilingTokens: 30_000, debug: false, hygieneN: 8 });

  const commits = await listCampaignHistory(campaign);
  expect(commits.length).toBeGreaterThanOrEqual(4);

  // Leave and come back: the new session is re-primed from the Campaign folder
  h.stopEvents?.();
  h.events = [];
  expect((await whenIdle("/api/leave")).status).toBe(204);
  expect((await call("POST", "/api/campaigns/open", { id })).status).toBe(200);
  await followEvents();
  stack.llama.push((c) => c.say("Mira nods as you return."));
  expect((await call("POST", "/api/turn", { text: "I go back inside." })).status).toBe(202);
  await waitFor(
    () => h!.events.some((e) => e.type === "turn_ended" && e.outcome === "success"),
    "turn after reopening",
  );
  const resumed = stack.llama.calls.at(-1)!;
  // the earlier Turns come back from transcript.jsonl, and memory is re-pinned from disk
  const history = resumed.messages.slice(1).map((m) => String(m.content));
  expect(history.some((t) => t.includes("I slip Mira a silver coin."))).toBe(true);
  expect(history.some((t) => t.includes("The fog lifts over Grey Spit."))).toBe(true);
  expect(resumed.prompt).toBe("I go back inside.");
  expect(String(resumed.messages[0]!.content).includes("Pinned Campaign memory")).toBe(true);
});

test("a Game Master still waking up is waited for, and Stop ends a Turn cleanly", async () => {
  let refusals = 2;
  const stack = await startHostedStack({
    fallback: async (c) => {
      c.think("Slowly…");
      c.say("The tide ");
      await c.aborted();
    },
  });
  const dir = await makeTempDir("nq-hosted-");
  const sealed = stack.sealedFetch();
  const waking: typeof sealed = async (p, init) => {
    // Runpod's load balancer answers 503 while a scale-to-zero worker boots
    if (refusals-- > 0) {
      const { RelayError } = await import("@nq/seal/browser.ts");
      throw new RelayError(503, "no workers available");
    }
    return sealed(p, init);
  };
  const app = await createHostedApp({
    agent: { transport: waking, sleep: async () => {} },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  h = { app, stack, dir, events: [] };
  const home = (await (await call("GET", "/api/home")).json()) as { packs: Array<{ id: string; name: string }> };
  const pack = home.packs.find((p) => p.name === "Brinewatch")!;
  expect((await call("POST", "/api/campaigns", { pack: pack.id })).status).toBe(201);
  await followEvents();

  expect((await call("POST", "/api/turn", { text: "I wait for the tide." })).status).toBe(202);
  await waitFor(() => h!.events.some((e) => e.type === "prose_delta"), "prose after waking");
  expect(refusals).toBeLessThan(0);
  // hosted play thinks at low effort unless the player asks for more, and a
  // thought cut off by the budget gets Qwen's early-stop line
  expect(stack.llama.calls[0]!.body).toMatchObject({
    reasoning_effort: "low",
    chat_template_kwargs: { reasoning_effort: "low" },
  });
  expect(String(stack.llama.calls[0]!.body.reasoning_budget_message)).toContain(
    "Considering the limited time by the user",
  );
  expect((await call("POST", "/api/interrupt")).status).toBeLessThan(300);
  await waitFor(() => endedTurns().length === 1, "stopped turn");
  // the book is idle again and can take the next Turn
  stack.llama.push((c) => c.say("The water stills."));
  expect((await whenIdle("/api/turn", { text: "I look again." })).status).toBe(202);
  await waitFor(() => endedTurns().length === 2, "next turn");
  expect(endedTurns()[1]).toMatchObject({ outcome: "success" });
});

test("a failed Turn keeps the player's words, and a slow cold start is not a stall", async () => {
  const stack = await startHostedStack({
    steps: [
      // the worker dies mid-reply
      (c) => {
        c.think("Starting…");
        c.error("worker lost");
      },
      // a cold worker: a long silence before the first token
      async (c) => {
        await Bun.sleep(1_600);
        c.say(`You asked: ${c.messages.filter((m) => m.role === "user").map((m) => m.content).join(" | ")}`);
      },
    ],
  });
  const dir = await makeTempDir("nq-hosted-");
  const app = await createHostedApp({
    agent: { transport: stack.sealedFetch(), sleep: async () => {}, heartbeatMs: 200 },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  h = { app, stack, dir, events: [] };
  const home = (await (await call("GET", "/api/home")).json()) as {
    settings: Record<string, unknown>;
    packs: Array<{ id: string; name: string }>;
  };
  // one second of silence ends a Turn, unless the agent reports it is still waiting
  expect((await call("POST", "/api/settings", { ...home.settings, turnTimeoutSec: 1 })).status).toBe(200);
  const pack = home.packs.find((p) => p.name === "Brinewatch")!;
  expect((await call("POST", "/api/campaigns", { pack: pack.id })).status).toBe(201);
  await followEvents();

  expect((await call("POST", "/api/turn", { text: "Make me a big male human." })).status).toBe(202);
  await waitFor(() => endedTurns().length === 1, "failed turn");
  expect(endedTurns()[0]).toMatchObject({ outcome: "fail" });

  expect((await whenIdle("/api/turn", { text: "(continue)" })).status).toBe(202);
  await waitFor(() => endedTurns().length === 2, "turn after the failure");
  expect(endedTurns()[1]).toMatchObject({ outcome: "success" });
  // the model still has what the player asked before the failure, once
  const rows = await readTranscript(app.home.play!.api.campaignPath);
  expect(rows.at(-1)?.text).toBe("You asked: Make me a big male human. | (continue)");
});

