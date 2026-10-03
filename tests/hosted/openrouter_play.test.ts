import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { readScratch } from "../../src/campaign/scratch.ts";
import { readTranscript } from "../../src/campaign/transcript.ts";
import { createHostedApp, HOSTED_THINKING_OPENER, type HostedApp } from "../../src/surfaces/hosted/app.ts";
import { connectGameMaster } from "../../src/agent/browser/connect.ts";
import relayWorker, { type RelayEnv } from "../../src/surfaces/hosted/relay.ts";
import { startFakeLlama, type FakeLlama } from "../helpers/fake_llama.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

/**
 * The hosted book on OpenRouter: Home → Play Loop → hosted agent → the relay
 * Worker's OpenRouter route → a stand-in for OpenRouter (the only fake).
 * The relay, not the page, decides the model and the privacy policy.
 */

const PACKS = path.join(import.meta.dir, "../../packs");
const RELAY = "http://relay.test/relay";
const ORIGIN = "http://nq.hosted";

let app: HostedApp | undefined;
let llama: FakeLlama | undefined;
let dir = "";
afterEach(async () => {
  await app?.home.leave().catch(() => {});
  await app?.dispose();
  llama?.stop();
  if (dir) await rmTempDir(dir);
  app = undefined;
  llama = undefined;
  dir = "";
});

function relayFor(env: RelayEnv) {
  return (input: string | URL | Request, init?: RequestInit) =>
    relayWorker.fetch(new Request(input, init), env);
}

async function call(method: string, route: string, body?: unknown): Promise<Response> {
  return app!.handler(
    new Request(`${ORIGIN}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function turn(text: string): Promise<void> {
  const before = (await readTranscript(app!.home.play!.api.campaignPath)).length;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await call("POST", "/api/turn", { text });
    if (res.status === 202) break;
    if (Date.now() > deadline) throw new Error(`turn refused: ${res.status}`);
    await Bun.sleep(5);
  }
  for (;;) {
    const rows = await readTranscript(app!.home.play!.api.campaignPath);
    if (rows.length >= before + 2 && rows.at(-1)?.role === "gm") return;
    if (Date.now() > deadline) throw new Error("turn did not finish");
    await Bun.sleep(5);
  }
}

test("a Turn on OpenRouter goes only to zero-retention providers, with the relay's model and key", async () => {
  llama = startFakeLlama({
    dialect: "openrouter",
    steps: [
      (c) => {
        c.think("The gulls decide.");
        c.tool("roll", { n: 6, i: "the gulls scatter" });
      },
      (c) => {
        c.think("A four.");
        c.say("The gulls lift off the pilings.");
      },
      (c) => c.say("Mira waves."),
    ],
  });
  const env: RelayEnv = {
    GM_BACKEND: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "qwen/qwen3.8-27b",
    OPENROUTER_IGNORE: "together, fireworks",
    OPENROUTER_ONLY: "deepinfra,venice",
    OPENROUTER_TEMPERATURE: "1.5",
    OPENROUTER_TOP_P: "1.0",
    OPENROUTER_BASE: `${llama.url}/v1`,
  };
  const relayFetch = relayFor(env) as typeof fetch;

  // the page learns only that OpenRouter is on: no worker key, no sealed routes
  expect(await (await relayFetch(`${RELAY}/config`)).json()).toEqual({
    backend: "openrouter",
    model: "qwen/qwen3.8-27b",
  });
  expect((await relayFetch(`${RELAY}/.seal/hello`, { method: "POST", body: "{}" })).status).toBe(404);

  dir = await makeTempDir("nq-openrouter-");
  const gameMaster = await connectGameMaster({ relay: RELAY, fetch: relayFetch });
  const usage: Array<{ cachedTokens?: number; cost?: number }> = [];
  app = await createHostedApp({
    agent: { ...gameMaster, sleep: async () => {}, onUsage: (u) => usage.push(u) },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  const home = (await (await call("GET", "/api/home")).json()) as { packs: Array<{ id: string; name: string }> };
  const pack = home.packs.find((p) => p.name === "Brinewatch")!;
  expect((await call("POST", "/api/campaigns", { pack: pack.id })).status).toBe(201);

  await turn("I walk to the dock.");
  const campaign = app.home.play!.api.campaignPath;
  expect((await readTranscript(campaign)).at(-1)?.text).toBe("The gulls lift off the pilings.");
  // thinking arrives as OpenRouter's reasoning_details and still reaches the Scratch
  const [scratch] = await readScratch(campaign);
  expect(scratch?.thinking).toContain("A four.");
  // what it thought before the roll stays on the Scratch beside what came after
  expect(scratch?.thinking).toBe("The gulls decide.\n\nA four.");
  // OpenRouter gets no thinking prefill, so the Scratch does not show one
  expect(scratch?.thinking).not.toContain(HOSTED_THINKING_OPENER);
  expect(scratch?.tools.map((t) => t.name)).toEqual(["roll"]);

  const [first, second] = llama.calls;
  // the relay's key, model and policy; the page never had the key
  expect(first!.headers.get("authorization")).toBe("Bearer sk-or-test");
  expect(first!.body).toMatchObject({
    model: "qwen/qwen3.8-27b",
    stream: true,
    temperature: 1.5,
    top_p: 1,
    reasoning: { effort: "low" },
    provider: {
      zdr: true,
      data_collection: "deny",
      ignore: ["together", "fireworks"],
      only: ["deepinfra", "venice"],
      sort: "price",
    },
  });
  // no llama.cpp-only thinking prefill or template fields
  expect(first!.body.continue_final_message).toBeUndefined();
  expect(first!.body.chat_template_kwargs).toBeUndefined();
  expect(first!.messages.at(-1)?.role).toBe("user");
  // a Qwen conversation carries no DeepSeek thinking-voice note
  expect(JSON.stringify(first!.messages)).not.toContain("角色沉浸");
  // one conversation stays on one provider, so its long prompt stays cached
  expect(typeof first!.body.session_id).toBe("string");
  expect(second!.body.session_id).toBe(first!.body.session_id);
  // earlier thinking goes back as `reasoning`, keeping the tool round coherent
  const toolRound = second!.messages.find((m) => m.role === "assistant");
  expect(toolRound?.reasoning).toBe("The gulls decide.");
  expect(toolRound?.reasoning_content).toBeUndefined();
  // OpenRouter's usage shows what caching saved and what the call cost
  expect(usage[0]).toMatchObject({ cachedTokens: 1000, cost: 0.00031 });

  await turn("I wave back.");
  expect(llama.calls[2]!.body.session_id).toBe(first!.body.session_id);
});

test("a roll the model planned but skipped is asked for before any reply shows", async () => {
  llama = startFakeLlama({
    dialect: "openrouter",
    steps: [
      // plans a roll in its thinking, then starts the reply without making it
      (c) => {
        c.think("Mira is watching the ferry and Ren has quick hands. Let me roll for this.\n\nStakes: low she notices, high a clean lift.");
        c.say("You lift the purse cleanly.");
      },
      // reminded, it makes the roll it planned
      (c) => c.tool("roll", { n: 100, i: "lift the purse unnoticed" }),
      (c) => c.say("Your fingers close on the purse, and Mira never looks down."),
      // a routine turn that decides against a roll is left alone
      (c) => {
        c.think("Routine. No roll needed.");
        c.say("Mira turns back to the ferry.");
      },
    ],
  });
  const relayFetch = relayFor({
    GM_BACKEND: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
    OPENROUTER_BASE: `${llama.url}/v1`,
  }) as typeof fetch;
  dir = await makeTempDir("nq-openrouter-");
  app = await createHostedApp({
    agent: { ...(await connectGameMaster({ relay: RELAY, fetch: relayFetch })), sleep: async () => {} },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  const home = (await (await call("GET", "/api/home")).json()) as { packs: Array<{ id: string; name: string }> };
  expect((await call("POST", "/api/campaigns", { pack: home.packs.find((p) => p.name === "Brinewatch")!.id })).status).toBe(201);

  await turn("I lift the coin purse from Mira's apron pocket.");
  const campaign = app.home.play!.api.campaignPath;
  const rows = await readTranscript(campaign);
  // the roll-less reply never reached the page; the rolled one did
  expect(rows.at(-1)?.text).toBe("Your fingers close on the purse, and Mira never looks down.");
  expect(rows.some((r) => r.text.includes("You lift the purse cleanly"))).toBe(false);
  const [scratch] = await readScratch(campaign);
  expect(scratch?.tools.map((t) => t.name)).toEqual(["roll"]);
  // the reminder went to the model once, as the last word before its roll
  const reminded = llama.calls[1]!;
  expect(String(reminded.messages.at(-1)?.content)).toContain("you decided this needs a roll");

  await turn("I wander back to the dock.");
  expect(llama.calls).toHaveLength(4);
  // the reminder is not part of the story the model sees afterwards
  const later = llama.calls[3]!.messages.map((m) => String(m.content)).join("\n");
  expect(later).not.toContain("you decided this needs a roll");
  expect(later).toContain("I lift the coin purse");
  expect((await readTranscript(campaign)).at(-1)?.text).toBe("Mira turns back to the ferry.");

  // DeepSeek V4 thinks as the Game Master in person: that note
  // rides on the first player message of every call, and only there
  for (const c of llama.calls) {
    const users = c.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(users[0]).toContain("【角色沉浸要求】");
    expect(users[0]).toContain("游戏主持人（Game Master）");
    expect(users.slice(1).join("\n")).not.toContain("角色沉浸");
  }
  // it is never written into the story
  expect(JSON.stringify(await readTranscript(campaign))).not.toContain("角色沉浸");
});

test("a page cannot turn off zero retention, swap the model, or lift the token cap", async () => {
  llama = startFakeLlama({ dialect: "openrouter" });
  const relayFetch = relayFor({
    GM_BACKEND: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE: `${llama.url}/v1`,
  });
  const res = await relayFetch(`${RELAY}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "some/expensive-model",
      messages: [{ role: "user", content: "hello" }],
      provider: { zdr: false, data_collection: "allow", only: ["together"] },
      temperature: 0.1,
      reasoning: { effort: "xhigh" },
      max_tokens: 1_000_000,
    }),
  });
  expect(await res.text()).toContain("[DONE]");
  expect(llama.calls[0]!.body).toMatchObject({
    model: "qwen/qwen3.8-27b",
    provider: { zdr: true, data_collection: "deny" },
    reasoning: { effort: "low" },
    max_tokens: 8192,
  });
  expect((llama.calls[0]!.body.provider as Record<string, unknown>).only).toBeUndefined();
  // sampling is the relay's: a page's temperature is dropped
  expect(llama.calls[0]!.body.temperature).toBeUndefined();

  // without a key the relay refuses rather than calling out
  const unkeyed = relayFor({ GM_BACKEND: "openrouter", OPENROUTER_BASE: `${llama.url}/v1` });
  expect((await unkeyed(`${RELAY}/chat`, { method: "POST", body: "{\"messages\":[]}" })).status).toBe(503);
  expect(llama.calls).toHaveLength(1);
});

async function snapshot(): Promise<{ busy: boolean; lastError?: string }> {
  const res = await call("GET", "/api/events");
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return JSON.parse(text.split("\n")[0]!);
}

test("a Game Master that thinks and then says nothing is asked once, and a Turn still left empty can be retried", async () => {
  llama = startFakeLlama({
    dialect: "openrouter",
    steps: [
      // thinks it through, then ends without a word for the player
      (c) => c.think("She weighs the coins against the risk."),
      // reminded, it writes the reply
      (c) => c.say("Mira pushes the coins back across the table."),
      // the next Turn stays empty even after the reminder
      (c) => c.think("Hm."),
      (c) => c.think("Still nothing to say."),
      // the player's Retry sends the same message again
      (c) => c.say("Mira laughs and pours another cup."),
    ],
  });
  const relayFetch = relayFor({
    GM_BACKEND: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE: `${llama.url}/v1`,
  }) as typeof fetch;
  dir = await makeTempDir("nq-openrouter-");
  app = await createHostedApp({
    agent: { ...(await connectGameMaster({ relay: RELAY, fetch: relayFetch })), sleep: async () => {} },
    dataDir: path.join(dir, "data"),
    packsDir: PACKS,
  });
  const home = (await (await call("GET", "/api/home")).json()) as { packs: Array<{ id: string; name: string }> };
  expect((await call("POST", "/api/campaigns", { pack: home.packs.find((p) => p.name === "Brinewatch")!.id })).status).toBe(201);
  const campaign = app.home.play!.api.campaignPath;

  await turn("I offer Mira fifty ceramic to take me along.");
  expect((await readTranscript(campaign)).at(-1)?.text).toBe("Mira pushes the coins back across the table.");
  expect(String(llama.calls[1]!.messages.at(-1)?.content)).toContain("Write your reply to the player now");

  // empty again after the reminder: the Turn fails, and the book says so
  const deadline = Date.now() + 10_000;
  while ((await call("POST", "/api/turn", { text: "I ask again." })).status !== 202) {
    if (Date.now() > deadline) throw new Error("turn refused");
    await Bun.sleep(5);
  }
  let snap = await snapshot();
  while (snap.busy || !snap.lastError) {
    if (Date.now() > deadline) throw new Error("the failed Turn never settled");
    await Bun.sleep(5);
    snap = await snapshot();
  }
  expect(snap.lastError).toContain("finished without replying");
  const beforeRetry = await readTranscript(campaign);
  const unanswered = beforeRetry.at(-1)!;
  expect(unanswered).toMatchObject({ role: "player", text: "I ask again." });

  // Retry on the unanswered message sends it once more, without a duplicate
  while ((await call("POST", "/api/retry", { ts: unanswered.ts })).status !== 202) {
    if (Date.now() > deadline) throw new Error("Retry refused");
    await Bun.sleep(5);
  }
  for (;;) {
    const rows = await readTranscript(campaign);
    // the message is taken back and sent again, then answered
    if (rows.length === beforeRetry.length + 1 && rows.at(-1)?.role === "gm") break;
    if (Date.now() > deadline) throw new Error("Retry never answered");
    await Bun.sleep(5);
  }
  const rows = await readTranscript(campaign);
  expect(rows.at(-1)?.text).toBe("Mira laughs and pours another cup.");
  expect(rows.filter((r) => r.text === "I ask again.")).toHaveLength(1);
  // reminders never stay in what the model sees
  const last = llama.calls.at(-1)!.messages.map((m) => String(m.content)).join("\n");
  expect(last).not.toContain("Game Master note");
  expect((await snapshot()).lastError).toBeUndefined();
});
