import { describe, expect, test } from "bun:test";
import { HttpApp } from "@effect/platform";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { defaultLocalRuntimeDir } from "@nq/local-inference/runtime.ts";
import {
  appendTranscriptRow,
  listCampaignHistory,
  loadPlayState,
  readScratch,
  readTranscript,
  type TranscriptRow,
  writeScratch,
} from "../../src/campaign/index.ts";
import { PlayLoop, playSessionLayer } from "../../src/play/index.ts";
import { serveHttpApp } from "../../src/surfaces/web/http.ts";
import { DEEPSEEK_V4_THINK_MAX } from "../../src/agent/wire_shaping.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  says,
  type ModelCall,
  type ScriptStep,
  type ScriptedGameMaster,
} from "../helpers/game_master.ts";
import { startLocalHost } from "../helpers/local_host.ts";

const ORIGIN = "http://127.0.0.1:7737";

async function waitForTranscript(
  campaign: string,
  ok: (rows: TranscriptRow[]) => boolean,
  timeoutMs = 2_000,
): Promise<TranscriptRow[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readTranscript(campaign);
    if (ok(rows)) return rows;
    await Bun.sleep(5);
  }
  const rows = await readTranscript(campaign);
  throw new Error(
    `transcript never reached the expected state (${rows.length} rows: ${rows
      .map((row) => row.role)
      .join(", ")})`,
  );
}

type SessionSnapshot = { busy: boolean; phase: string; successTurnCount: number };

/** The first line of /api/events: the same snapshot the book starts from. */
async function readSnapshot(
  handler: (req: Request) => Promise<Response>,
): Promise<SessionSnapshot> {
  const res = await handler(new Request(`${ORIGIN}/api/events`));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return JSON.parse(buffered.split("\n")[0]!) as SessionSnapshot;
}

/** Wait until the session snapshot satisfies `ok`, instead of sleeping. */
async function waitForSnapshot(
  handler: (req: Request) => Promise<Response>,
  ok: (snap: SessionSnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ok(await readSnapshot(handler))) return;
    await Bun.sleep(5);
  }
  throw new Error("play session never reached the expected state");
}

/**
 * Wait until the Play Loop accepts commands again. The snapshot reports idle
 * at turn_ended, but the loop still commits before it takes the next command,
 * so probe the loop's own gate: editing an unknown row is 409 while busy and a
 * side-effect-free 404 once idle.
 */
async function waitForLoopIdle(
  handler: (req: Request) => Promise<Response>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await handler(
      new Request(`${ORIGIN}/api/transcript/edit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        },
        body: JSON.stringify({ ts: "1970-01-01T00:00:00.000Z", text: "probe" }),
      }),
    );
    if (res.status !== 409) return;
    await Bun.sleep(5);
  }
  throw new Error("play loop never became idle");
}

const DEFAULT_PROSE = "Mira looks at your hands, not your face.";

/**
 * Text of the instruction a model call answers: the player's input, or the
 * hidden pass (Memory Hygiene, Continue) that the loop sends as a developer
 * message after it. `call.prompt` only sees user messages.
 */
function instruction(call: ModelCall): string {
  const messages = call.context.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "developer") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";
  }
  return "";
}

const isHygiene = (call: ModelCall) =>
  instruction(call).startsWith("[Memory Hygiene");

/** A reply that keeps the Game Master busy until the player presses Stop. */
function untilStopped(entered?: { resolve: () => void }): ScriptStep {
  return async (call) => {
    call.say("The well is deep");
    entered?.resolve();
    await call.aborted();
  };
}

/**
 * Real Play Session + HTTP routes over the real OMP Game Master; only the
 * model is scripted. Without a script every Turn answers DEFAULT_PROSE.
 */
async function boot(
  campaign: string,
  gm?: ScriptedGameMaster,
  config?: { hygieneN?: number },
) {
  const layer = playSessionLayer({
    path: campaign,
    factory: (gm ?? (await scriptedGameMaster({ fallback: says(DEFAULT_PROSE) })))
      .factory,
    config,
  });
  return HttpApp.toWebHandlerLayer(serveHttpApp, layer);
}

/**
 * Resolve on the first live-scratch event that carries thinking: the Game
 * Master's reasoning has reached the Play Loop (and so passed through the
 * Local Inference Host, which now knows the completion to cut off).
 */
async function thinkingArrives(
  handler: (req: Request) => Promise<Response>,
): Promise<() => Promise<void>> {
  const res = await handler(new Request(`${ORIGIN}/api/events`));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return async () => {
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended before any thinking");
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const event = JSON.parse(line) as { type?: string; thinking?: string };
          if (event.type === "scratch_live" && event.thinking) return;
        }
      }
    } finally {
      await reader.cancel();
    }
  };
}

describe("nq serve HTTP", () => {
  test("inspect sheet returns the Player Sheet body", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet:
          "## Description\n**Ren Caldew** — a lean dock runner out of Brinewatch.\n\n## Inventory\n- oilskin coat\n\n## Powers\n### Salt-lung\n\n## Notes\n- Mira Venn\n",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { target: string; text: string };
        expect(body.target).toBe("sheet");
        expect(body.text).toContain("Ren Caldew");
        expect(body.text).toContain("Salt-lung");
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });


  test("GET /api/local/log exposes only named bounded log sources", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/local/log?source=engine"),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = (await res.json()) as {
          source: string;
          text: string;
          nextOffset: number;
          reset: boolean;
          available: boolean;
        };
        expect(body.source).toBe("engine");
        expect(typeof body.text).toBe("string");
        expect(Number.isSafeInteger(body.nextOffset)).toBe(true);
        expect(typeof body.reset).toBe("boolean");
        expect(typeof body.available).toBe("boolean");

        const denied = await handler(
          new Request("http://127.0.0.1:7737/api/local/log?source=../../secret"),
        );
        expect(denied.status).toBe(400);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });
  test("GET /api/local/log shows the running engine's own log, and starts over when the engine changes", async () => {
    const root = await makeTempDir();
    const local = defaultLocalRuntimeDir();
    try {
      await mkdir(path.join(local, "logs"), { recursive: true });
      await Bun.write(path.join(local, "logs", "llama-server.log"), "atomic: model loaded\n");
      await Bun.write(path.join(local, "logs", "exl3xpu.log"), "vllm: Loading safetensors checkpoint shards 3/3\n");
      const run = (engine?: string) =>
        Bun.write(
          path.join(local, "run.json"),
          JSON.stringify({
            schema: 1,
            pid: 1,
            port: 8081,
            alias: "twilight",
            serverPath: "/usr/bin/bwrap",
            startedAt: new Date().toISOString(),
            ...(engine ? { engine } : {}),
          }),
        );
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      const read = async (query: string) =>
        (await (
          await handler(new Request(`http://127.0.0.1:7737/api/local/log?${query}`))
        ).json()) as { file: string; text: string; nextOffset: number; reset: boolean };
      try {
        await run("exl3xpu");
        const vllm = await read("source=engine");
        expect(vllm.file).toBe("exl3xpu.log");
        expect(vllm.text).toContain("checkpoint shards 3/3");

        // Atomic takes over: the old offset belongs to the other file
        await run();
        const atomic = await read(`source=engine&offset=${vllm.nextOffset}&file=${vllm.file}`);
        expect(atomic).toMatchObject({ file: "llama-server.log", reset: true });
        expect(atomic.text).toContain("atomic: model loaded");
      } finally {
        await dispose();
      }
    } finally {
      await rm(path.join(local, "run.json"), { force: true });
      await rm(path.join(local, "logs"), { recursive: true, force: true });
      await rmTempDir(root);
    }
  });
  test("POST /api/turn without Origin is 403", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: { "content-type": "application/json", Host: "127.0.0.1:7737" },
            body: JSON.stringify({ text: "I wait." }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });
  test("Luck Points max and consume the next Campaign roll", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the Game Master really calls the Campaign `roll` tool
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("roll", { n: 20 }),
          (c) => c.say(`The die lands on ${c.toolResults[0]?.text}.`),
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const armed = await handler(
          new Request("http://127.0.0.1:7737/api/luck", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Host: "127.0.0.1:7737",
              Origin: ORIGIN,
            },
            body: JSON.stringify({ armed: true }),
          }),
        );
        expect(armed.status).toBe(200);
        expect(await armed.json()).toMatchObject({
          luck_points: 5,
          luck_armed: true,
        });

        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Host: "127.0.0.1:7737",
              Origin: ORIGIN,
            },
            body: JSON.stringify({ text: "Take the chance." }),
          }),
        );
        expect(turn.status).toBe(202);
        const rows = await waitForTranscript(campaign, (rows) =>
          rows.some((row) => row.role === "gm"),
        );

        expect(gm.calls[1]?.toolResults).toMatchObject([{ name: "roll", text: "20" }]);
        expect(rows.at(-1)?.text).toBe("The die lands on 20.");
        await waitForLoopIdle(handler);
        expect(await loadPlayState(campaign)).toMatchObject({
          luck_points: 4,
          luck_armed: false,
        });
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });


  test("GET /api/events first line is a kernel snapshot", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\n## Opening message\n\nMira Venn watches you from the Salt Lamp doorway.\n",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const ev = await handler(new Request("http://127.0.0.1:7737/api/events"));
        expect(ev.status).toBe(200);
        expect(ev.headers.get("content-type")).toContain("ndjson");
        const reader = ev.body!.getReader();
        const first = await reader.read();
        const line = new TextDecoder().decode(first.value);
        const snap = JSON.parse(line.split("\n")[0]!);
        expect(snap.phase).toBe("idle");
        expect(Array.isArray(snap.story)).toBe(true);
        await reader.cancel();
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/turn over a LAN host needs an exactly matching Origin", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const post = (origin?: string) =>
          handler(
            new Request("http://192.168.1.20:7737/api/turn", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Host: "192.168.1.20:7737",
                ...(origin ? { Origin: origin } : {}),
              },
              body: JSON.stringify({ text: "I wait." }),
            }),
          );
        expect((await post()).status).toBe(403);
        expect((await post("http://127.0.0.1:7737")).status).toBe(403);
        expect((await post("http://192.168.1.20:7738")).status).toBe(403);
        expect((await post("http://evil.example")).status).toBe(403);
        expect((await post("http://192.168.1.20:7737")).status).toBe(202);
        await waitForTranscript(campaign, (rows) =>
          rows.some((row) => row.role === "gm"),
        );
        await waitForLoopIdle(handler);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });
  test("POST /api/turn with loopback Origin is 202", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I nod to Mira." }),
          }),
        );
        expect(res.status).toBe(202);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("GET /api/events after a Turn has ts on story rows matching transcript", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I nod to Mira." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForLoopIdle(handler);
        const ev = await handler(new Request("http://127.0.0.1:7737/api/events"));
        expect(ev.status).toBe(200);
        const reader = ev.body!.getReader();
        const first = await reader.read();
        const snap = JSON.parse(
          new TextDecoder().decode(first.value).split("\n")[0]!,
        ) as { story: Array<{ ts?: string; text: string }> };
        await reader.cancel();
        const rows = await readTranscript(campaign);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(snap.story.map((b) => b.ts)).toEqual(rows.map((r) => r.ts));
        expect(snap.story.map((b) => b.text)).toEqual(rows.map((r) => r.text));
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/interrupt is 204; overlapping turn is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({ steps: [untilStopped(entered)] });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait at the well." }),
          }),
        );
        expect(first.status).toBe(202);
        // the Game Master is mid-reply (not merely the Turn started)
        await entered.promise;
        const second = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "again" }),
          }),
        );
        expect(second.status).toBe(409);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
        // Stop really aborted the model call the Turn was waiting on
        await waitForLoopIdle(handler);
        expect(gm.calls[0]?.signal?.aborted).toBe(true);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/interrupt stops Memory Hygiene and play goes on", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const hygieneEntered = Promise.withResolvers<void>();
      let hygienePasses = 0;
      const gm = await scriptedGameMaster({
        fallback: async (call) => {
          if (!isHygiene(call)) return call.say(DEFAULT_PROSE);
          // the first pass runs until Stop; later ones finish
          if (++hygienePasses > 1) return call.say("hygiene ok");
          hygieneEntered.resolve();
          await call.aborted();
        },
      });
      // hygiene after every Turn
      const { handler, dispose } = await boot(campaign, gm, { hygieneN: 1 });
      const post = (route: string, body?: unknown) =>
        handler(
          new Request(`${ORIGIN}${route}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      try {
        expect((await post("/api/turn", { text: "I wait at the well." })).status).toBe(202);
        await hygieneEntered.promise;
        expect((await readSnapshot(handler)).busy).toBe(true);

        expect((await post("/api/interrupt")).status).toBe(204);
        await waitForLoopIdle(handler);
        const hygieneCall = gm.calls.find(isHygiene)!;
        expect(hygieneCall.signal?.aborted).toBe(true);
        // the Turn's reply stands; hygiene will cover it next time
        expect((await readTranscript(campaign)).at(-1)).toMatchObject({
          role: "gm",
          text: DEFAULT_PROSE,
        });
        const state = await loadPlayState(campaign);
        expect(state.last_hygiene_status).toBe("fail");
        expect(state.last_hygiene_transcript_line ?? 0).toBe(0);

        // the next Turn runs on a clean session: no trace of the stopped pass
        const before = gm.calls.length;
        const rows = (await readTranscript(campaign)).length;
        expect((await post("/api/turn", { text: "I draw water." })).status).toBe(202);
        await waitForTranscript(campaign, (next) => next.length === rows + 2);
        const next = gm.calls.slice(before).find((c) => !isHygiene(c))!;
        expect(JSON.stringify(next.context.messages)).not.toContain("[Memory Hygiene");
        await waitForLoopIdle(handler);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("a local DeepSeek-V4 GGUF gets chat completions, its opener, and DeepSeek's effort levels", async () => {
    // installed in NQ's (sandboxed) local root, where the Game Master looks up
    // the model's architecture; registered as OMP's discovery would on a real
    // machine, which sends local models through the Responses API
    const host = await startLocalHost({
      defaultRoot: true,
      architecture: "deepseek4",
      engine: { holdReasoning: false, reasoning: "Weighing it.", reply: "The tide turns." },
    });
    const root = await makeTempDir();
    const opener = "First, what the player just did:";
    try {
      await host.activate();
      const sent = async (thinkingLevel: string) => {
        const campaign = await birthCampaign(path.join(root, thinkingLevel));
        const loop = new PlayLoop({
          path: campaign,
          factory: await host.gameMaster(
            { thinkingLevel, localThinkingOpener: opener },
            { discovered: true },
          ),
        });
        await loop.open();
        const before = host.engine.completions.length;
        expect((await loop.turn("I read the tide.")).outcome).toBe("success");
        await loop.close();
        // reaching the engine's chat completions route at all is the reroute
        const body = host.engine.completions.slice(before).at(-1)!;
        const messages = body.messages as Array<Record<string, unknown>>;
        return {
          thinking: (body.chat_template_kwargs as Record<string, unknown> | undefined)
            ?.enable_thinking,
          system: String(messages[0]?.content),
          last: messages.at(-1)!,
        };
      };

      // Think High: thinking on, opened with the player's own opener
      const high = await sent("medium");
      expect(high.thinking).toBe(true);
      expect(high.last).toMatchObject({ role: "assistant", reasoning_content: opener });
      expect(high.system.startsWith(DEEPSEEK_V4_THINK_MAX)).toBe(false);

      // Think Max: DeepSeek's effort paragraph heads the prompt
      const max = await sent("max");
      expect(max.thinking).toBe(true);
      expect(max.system.startsWith(DEEPSEEK_V4_THINK_MAX)).toBe(true);

      // non-think: thinking off, and no opener to force a reasoning block
      const off = await sent("off");
      expect(off.thinking).toBe(false);
      expect(off.last.role).toBe("user");
    } finally {
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("a local Qwen3.8-template GGUF gets chat completions, its opener, and the reasoning setting as its effort", async () => {
    // Bonsai 2's alias is one OMP does not know as Qwen, so discovery leaves it
    // on the Responses API; NQ must route it by the GGUF's own chat template
    const qwenTemplate = await Bun.file(
      path.join(import.meta.dir, "../fixtures/qwen3.8-chat-template.jinja"),
    ).text();
    // MiMo-style: an on/off switch and no effort levels
    const toggleOnly =
      "{%- if enable_thinking is false -%}<think></think>{%- endif -%}";
    const root = await makeTempDir();
    const opener = "First, what the player just did:";
    const sent = async (
      host: Awaited<ReturnType<typeof startLocalHost>>,
      thinkingLevel: string,
    ) => {
      const campaign = await birthCampaign(path.join(root, `${host.alias}-${thinkingLevel}`));
      const loop = new PlayLoop({
        path: campaign,
        factory: await host.gameMaster(
          { thinkingLevel, localThinkingOpener: opener },
          { discovered: true },
        ),
      });
      await loop.open();
      const before = host.engine.completions.length;
      expect((await loop.turn("I read the tide.")).outcome).toBe("success");
      await loop.close();
      // reaching the engine's chat completions route at all is the reroute
      const body = host.engine.completions.slice(before).at(-1)!;
      const messages = body.messages as Array<Record<string, unknown>>;
      return {
        kwargs: (body.chat_template_kwargs ?? {}) as Record<string, unknown>,
        effort: body.reasoning_effort,
        last: messages.at(-1)!,
      };
    };

    try {
      const qwen = await startLocalHost({
        defaultRoot: true,
        alias: "ternary-bonsai-2-27b-test",
        architecture: "qwen35",
        chatTemplate: qwenTemplate,
        engine: { holdReasoning: false, reasoning: "Weighing it.", reply: "The tide turns." },
      });
      try {
        await qwen.activate();
        // left unset, the template thinks at xhigh whatever NQ's setting says
        for (const [level, effort] of [
          ["low", "low"],
          ["medium", "medium"],
          ["high", "xhigh"],
          ["max", "xhigh"],
        ] as const) {
          const wire = await sent(qwen, level);
          expect(wire.kwargs).toMatchObject({
            enable_thinking: true,
            preserve_thinking: true,
            reasoning_effort: effort,
          });
          // llama-server copies a top-level effort over the kwarg
          expect(wire.effort).toBe(effort);
          expect(wire.last).toMatchObject({ role: "assistant", reasoning_content: opener });
        }

        const off = await sent(qwen, "off");
        expect(off.kwargs.enable_thinking).toBe(false);
        expect(off.kwargs.reasoning_effort).toBeUndefined();
        expect(off.effort).toBeUndefined();
        expect(off.last.role).toBe("user");
      } finally {
        await qwen.stop();
      }

      const mimo = await startLocalHost({
        defaultRoot: true,
        alias: "distill-9b-test",
        architecture: "qwen35",
        chatTemplate: toggleOnly,
        engine: { holdReasoning: false, reasoning: "Weighing it.", reply: "The tide turns." },
      });
      try {
        await mimo.activate();
        // a template with no effort levels gets none, which it would not accept
        const wire = await sent(mimo, "high");
        expect(wire.kwargs.enable_thinking).toBe(true);
        expect(wire.kwargs.reasoning_effort).toBeUndefined();
        expect(wire.effort).toBeUndefined();
        expect(wire.last).toMatchObject({ role: "assistant", reasoning_content: opener });
      } finally {
        await mimo.stop();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/reasoning/end forwards a same-origin cutoff", async () => {
    const root = await makeTempDir();
    // a real Local Inference Host whose llama.cpp engine is faked; the engine
    // holds its think block open until the host relays `reasoning_end`
    const host = await startLocalHost({
      engine: { reasoning: "Weighing the tide tables.", reply: "The tide turns." },
    });
    try {
      await host.activate();
      const campaign = await birthCampaign(root);
      // the real Game Master for llama.cpp/<alias>: OMP's own client streams
      // through the host to the engine, which holds its think block open
      // until the host relays `reasoning_end`
      const layer = playSessionLayer({
        path: campaign,
        factory: await host.gameMaster(),
        // the same wiring src/cli.ts gives `nq serve`, on this host's root
        endReasoning: host.endReasoning,
      });
      const { handler, dispose } = HttpApp.toWebHandlerLayer(serveHttpApp, layer);
      try {
        const request = (origin = true) =>
          handler(
            new Request("http://127.0.0.1:7737/api/reasoning/end", {
              method: "POST",
              headers: {
                ...(origin ? { Origin: ORIGIN } : {}),
                Host: "127.0.0.1:7737",
              },
            }),
          );
        const thinking = await thinkingArrives(handler);
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I read the tide." }),
          }),
        );
        expect(turn.status).toBe(202);
        await thinking();

        expect((await request(false)).status).toBe(403);
        expect(host.engine.controls).toEqual([]);
        expect((await request()).status).toBe(204);
        expect(host.engine.controls).toEqual([
          {
            path: "/v1/chat/completions/control",
            body: { id: "chatcmpl-fake-1", action: "reasoning_end" },
          },
        ]);
        // the engine moved on to the answer, and the Turn finished with it
        const rows = await waitForTranscript(campaign, (rows) =>
          rows.some((row) => row.role === "gm"),
        );
        expect(rows.at(-1)?.text).toBe("The tide turns.");
        await waitForLoopIdle(handler);
        const [scratch] = await readScratch(campaign);
        expect(scratch?.thinking).toBe("Weighing the tide tables.");
        // the host saw the completion leave: nothing left to cut off
        expect((await request()).status).toBe(409);
        expect(host.engine.controls).toHaveLength(1);
        expect(host.engine.completions[0]).toMatchObject({
          stream: true,
          reasoning_control: true,
        });
        expect(host.engine.completions[0]).not.toHaveProperty("nq_client_pid");
      } finally {
        await dispose();
      }
    } finally {
      await host.stop();
      await rmTempDir(root);
    }
  });

  test("POST /api/transcript/edit without Origin is 403", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers: { "content-type": "application/json", Host: "127.0.0.1:7737" },
            body: JSON.stringify({ ts: "x", text: "y" }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/transcript/edit is 204 and changes text only", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const first = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Mira watches.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const later = await appendTranscriptRow(campaign, {
        role: "player",
        text: "I nod.",
        ts: "2026-01-01T00:00:01.000Z",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ ts: first.ts, text: "Mira watches the door." }),
          }),
        );
        expect(res.status).toBe(204);
        const rows = await readTranscript(campaign);
        expect(rows[0]).toEqual({
          ts: first.ts,
          role: "gm",
          text: "Mira watches the door.",
        });
        expect(rows[1]).toEqual(later);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/transcript/delete last pair is 204 and prunes scratch", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "one",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "first reply",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "two",
        ts: "2026-01-01T00:00:02.000Z",
      });
      const lastGm = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "second reply",
        ts: "2026-01-01T00:00:03.000Z",
      });
      await writeScratch(campaign, [
        { ts: "2026-01-01T00:00:01.000Z", turn: 1, thinking: "a", tools: [] },
        { ts: lastGm.ts, turn: 2, thinking: "b", tools: [] },
      ]);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/delete", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ ts: lastGm.ts }),
          }),
        );
        expect(res.status).toBe(204);
        const rows = await readTranscript(campaign);
        expect(rows.map((r) => r.text)).toEqual(["one", "first reply"]);
        const scratch = await readScratch(campaign);
        expect(scratch.map((r) => r.ts)).toEqual(["2026-01-01T00:00:01.000Z"]);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/retry rewinds and resubmits the latest player Turn", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const firstLoop = new PlayLoop({
        path: campaign,
        factory: (await scriptedGameMaster({ steps: [says("The first answer.")] }))
          .factory,
      });
      await firstLoop.open();
      await firstLoop.turn("I ask again.");
      await firstLoop.close();
      const firstGm = (await readTranscript(campaign)).at(-1)!;

      const gm = await scriptedGameMaster({
        steps: [says("The reconsidered answer.")],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const retry = await handler(
          new Request("http://127.0.0.1:7737/api/retry", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ ts: firstGm.ts }),
          }),
        );
        expect(retry.status).toBe(202);

        const retried = await waitForTranscript(
          campaign,
          (rows) => rows.at(-1)?.text === "The reconsidered answer.",
        );
        expect(retried.map((row) => [row.role, row.text])).toEqual([
          ["player", "I ask again."],
          ["gm", "The reconsidered answer."],
        ]);
        // the reply row lands before play state is saved; wait for the Turn
        await waitForLoopIdle(handler);
        expect((await loadPlayState(campaign)).success_turn_count).toBe(1);
        // the resubmitted player Turn is what the Game Master answered
        expect(gm.calls.map((c) => c.prompt)).toEqual(["I ask again."]);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/transcript/delete mid-log is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const first = await appendTranscriptRow(campaign, {
        role: "player",
        text: "one",
        ts: "2026-01-01T00:00:00.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "two",
        ts: "2026-01-01T00:00:01.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "player",
        text: "three",
        ts: "2026-01-01T00:00:02.000Z",
      });
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "four",
        ts: "2026-01-01T00:00:03.000Z",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/delete", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ ts: first.ts }),
          }),
        );
        expect(res.status).toBe(409);
        expect(await readTranscript(campaign)).toHaveLength(4);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST transcript edit/delete while Turning is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const gm = await scriptedGameMaster({ steps: [untilStopped()] });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait at the well." }),
          }),
        );
        expect(first.status).toBe(202);
        await waitForSnapshot(handler, (snap) => snap.busy);
        const edit = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({
              ts: "2026-01-01T00:00:00.000Z",
              text: "changed",
            }),
          }),
        );
        expect(edit.status).toBe(409);
        const del = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/delete", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(del.status).toBe(409);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/transcript/edit 400 on bad body and 404 on unknown ts", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "opening",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const missing = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers,
            body: JSON.stringify({ text: "no ts" }),
          }),
        );
        expect(missing.status).toBe(400);
        const notString = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers,
            body: JSON.stringify({ ts: 1, text: "x" }),
          }),
        );
        expect(notString.status).toBe(400);
        const missing_ = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers,
            body: JSON.stringify({ ts: "missing", text: "x" }),
          }),
        );
        expect(missing_.status).toBe(404);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST transcript edit/delete while hygiene is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const release = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        fallback: async (c) => {
          if (!isHygiene(c)) return c.say("story");
          await release.promise;
          c.say("hygiene");
        },
      });
      const { handler, dispose } = await boot(campaign, gm, { hygieneN: 1 });
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "go" }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForSnapshot(handler, (snap) => snap.phase === "hygiene");
        const edit = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({
              ts: "2026-01-01T00:00:00.000Z",
              text: "x",
            }),
          }),
        );
        expect(edit.status).toBe(409);
        const del = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/delete", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({}),
          }),
        );
        expect(del.status).toBe(409);
        release.resolve();
        await waitForLoopIdle(handler);
        expect(gm.calls.filter(isHygiene)).toHaveLength(1);
      } finally {
        release.resolve();
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("GET /api/events subscribers receive story_replaced with ts after edit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const opening = await appendTranscriptRow(campaign, {
        role: "gm",
        text: "Mira watches.",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const ev = await handler(new Request("http://127.0.0.1:7737/api/events"));
        expect(ev.status).toBe(200);
        const reader = ev.body!.getReader();
        const first = await reader.read();
        const snap = JSON.parse(
          new TextDecoder().decode(first.value).split("\n")[0]!,
        );
        expect(snap.story[0]).toMatchObject({
          role: "gm",
          text: "Mira watches.",
          ts: opening.ts,
        });

        const edited = await handler(
          new Request("http://127.0.0.1:7737/api/transcript/edit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ ts: opening.ts, text: "Mira watches the door." }),
          }),
        );
        expect(edited.status).toBe(204);

        const next = await reader.read();
        const line = new TextDecoder().decode(next.value);
        const event = JSON.parse(line.split("\n")[0]!);
        expect(event.type).toBe("story_replaced");
        expect(event.story[0]).toEqual({
          role: "gm",
          text: "Mira watches the door.",
          ts: opening.ts,
          turn: 0,
        });
        await reader.cancel();
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/continue extends HEAD without a confirm field", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("picked up the sword…")],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForLoopIdle(handler);
        const before = await readTranscript(campaign);
        const gmRow = before.find((r) => r.role === "gm")!;
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ turn: 1 }),
          }),
        );
        expect(res.status).toBe(202);
        const after = await waitForTranscript(
          campaign,
          (rows) => rows[1]?.text === "And then he picked up the sword…",
        );
        expect(after.map((r) => r.role)).toEqual(["player", "gm"]);
        expect(after[1]?.ts).toBe(gmRow.ts);
        expect(after[1]?.text).toBe("And then he picked up the sword…");
        expect(after.some((r) => r.text === "(continue)")).toBe(false);
        // Continue is a hidden instruction on the same Game Master line
        expect(instruction(gm.calls[1]!)).toStartWith("[Continue");
        await waitForLoopIdle(handler);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/continue while Turning is 409; confirm is not required", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "And then he",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const gm = await scriptedGameMaster({ steps: [untilStopped()] });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait at the well." }),
          }),
        );
        expect(first.status).toBe(202);
        await waitForSnapshot(handler, (snap) => snap.busy);
        const cont = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ turn: 0 }),
          }),
        );
        expect(cont.status).toBe(409);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/continue unknown turn is 404", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await appendTranscriptRow(campaign, {
        role: "gm",
        text: "And then he",
        ts: "2026-01-01T00:00:00.000Z",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const missing = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers,
            body: JSON.stringify({ turn: 9 }),
          }),
        );
        expect(missing.status).toBe(404);
        const noOpening = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers,
            body: JSON.stringify({ turn: 1 }),
          }),
        );
        expect(noOpening.status).toBe(404);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("two overlapping POST /api/continue cannot both return 202", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [says("And then he"), says("picked up the sword…")],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForLoopIdle(handler);
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const req = () =>
          handler(
            new Request("http://127.0.0.1:7737/api/continue", {
              method: "POST",
              headers,
              body: JSON.stringify({ turn: 1 }),
            }),
          );
        const [a, b] = await Promise.all([req(), req()]);
        expect([a.status, b.status].sort()).toEqual([202, 409]);
        await waitForTranscript(
          campaign,
          (rows) => rows[1]?.text === "And then he picked up the sword…",
        );
        await waitForLoopIdle(handler);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/continue while Continue is in flight is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        fallback: async (c) => {
          if (instruction(c).startsWith("[Continue")) {
            return untilStopped(entered)(c);
          }
          c.say("And then he");
        },
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForLoopIdle(handler);
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ turn: 1 }),
          }),
        );
        expect(first.status).toBe(202);
        await entered.promise;
        const second = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ turn: 1 }),
          }),
        );
        expect(second.status).toBe(409);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/continue without Origin is 403; bad body is 400", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const denied = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers: { "content-type": "application/json", Host: "127.0.0.1:7737" },
            body: JSON.stringify({ turn: 0 }),
          }),
        );
        expect(denied.status).toBe(403);
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const missing = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          }),
        );
        expect(missing.status).toBe(400);
        const notInt = await handler(
          new Request("http://127.0.0.1:7737/api/continue", {
            method: "POST",
            headers,
            body: JSON.stringify({ turn: 1.5 }),
          }),
        );
        expect(notInt.status).toBe(400);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("unknown inspect target is 404", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/transcript"),
        );
        expect(res.status).toBe(404);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT /api/inspect/sheet saves raw body when If-Match matches", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const got = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        expect(got.status).toBe(200);
        const loaded = (await got.json()) as { text: string; hash: string };
        expect(loaded.hash).toBeTruthy();
        const next = "## Description\n**Ren Caldew** — dock runner.\n";
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet", {
            method: "PUT",
            headers: {
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
              "If-Match": loaded.hash,
            },
            body: next,
          }),
        );
        expect(res.status).toBe(204);
        const after = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        const body = (await after.json()) as { text: string };
        expect(body.text).toBe(next);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT /api/inspect/sheet is 409 stale and returns disk text", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const got = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        const loaded = (await got.json()) as { hash: string };
        const { writeFile } = await import("node:fs/promises");
        const { PLAYER_SHEET_MD } = await import("../../src/campaign/index.ts");
        const disk = "## Description\nchanged on disk\n";
        await writeFile(`${campaign}/${PLAYER_SHEET_MD}`, disk);
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet", {
            method: "PUT",
            headers: {
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
              "If-Match": loaded.hash,
            },
            body: "## Description\nplayer edit\n",
          }),
        );
        expect(res.status).toBe(409);
        const stale = (await res.json()) as { text: string; hash: string };
        expect(stale.text).toBe(disk);
        expect(stale.hash).toBeTruthy();
        expect(await Bun.file(`${campaign}/${PLAYER_SHEET_MD}`).text()).toBe(disk);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/inspect/dossiers creates a slug", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({
              slug: "kell-brine",
              body: "---\nname: Kell Brine\n---\nFerry hand.\n",
            }),
          }),
        );
        expect(res.status).toBe(201);
        const created = (await res.json()) as { slug: string; text: string };
        expect(created.slug).toBe("kell-brine");
        const leaf = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers/kell-brine"),
        );
        expect(leaf.status).toBe(200);
        expect(((await leaf.json()) as { text: string }).text).toContain(
          "Ferry hand.",
        );
        const again = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ slug: "kell-brine" }),
          }),
        );
        expect(again.status).toBe(409);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT /api/inspect/seed rewrites the seed", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\nMira keeps the Salt Lamp.\n",
      });
      const { SEED_MD } = await import("../../src/campaign/index.ts");
      const { handler, dispose } = await boot(campaign);
      try {
        const got = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/seed"),
        );
        expect(got.status).toBe(200);
        const loaded = (await got.json()) as { text: string; hash: string };
        expect(loaded.text).toBe("# Brinewatch\n\nMira keeps the Salt Lamp.\n");
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/seed", {
            method: "PUT",
            headers: {
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
              "If-Match": loaded.hash,
            },
            body: "# Brinewatch\n\nKell keeps the Salt Lamp now.\n",
          }),
        );
        expect(res.status).toBe(204);
        expect(await Bun.file(`${campaign}/${SEED_MD}`).text()).toBe(
          "# Brinewatch\n\nKell keeps the Salt Lamp now.\n",
        );
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT inspect while Turning is 409; GET inspect is still 200", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        sheet: "## Description\nRen Caldew\n",
      });
      const gm = await scriptedGameMaster({ steps: [untilStopped()] });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const got = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        const loaded = (await got.json()) as { hash: string; text: string };
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait at the well." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForSnapshot(handler, (snap) => snap.busy);
        const during = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet"),
        );
        expect(during.status).toBe(200);
        expect(((await during.json()) as { text: string }).text).toBe(loaded.text);
        const save = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet", {
            method: "PUT",
            headers: {
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
              "If-Match": loaded.hash,
            },
            body: "## Description\nedited mid-turn\n",
          }),
        );
        expect(save.status).toBe(409);
        const create = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ slug: "kell-brine" }),
          }),
        );
        expect(create.status).toBe(409);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
        // the stopped Turn still writes its reply; let it land before cleanup
        await waitForSnapshot(handler, (snap) => !snap.busy);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT inspect writes world, beats, quests, and an existing dossier", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        world: "The marsh expands.\n",
        dossiers: {
          "mira-venn": "---\nname: Mira Venn\n---\nInnkeeper.\n",
        },
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const headers = {
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        for (const [url, next] of [
          ["/api/inspect/world", "Fog over Brinewatch.\n"],
          ["/api/inspect/beats", "- entered the Salt Lamp\n"],
          ["/api/inspect/quests", "- recover the drowned bell\n"],
          ["/api/inspect/dossiers/mira-venn", "Innkeeper of the Salt Lamp.\n"],
        ] as const) {
          const got = await handler(new Request(`http://127.0.0.1:7737${url}`));
          expect(got.status).toBe(200);
          const loaded = (await got.json()) as { hash: string };
          const res = await handler(
            new Request(`http://127.0.0.1:7737${url}`, {
              method: "PUT",
              headers: { ...headers, "If-Match": loaded.hash },
              body: next,
            }),
          );
          expect(res.status).toBe(204);
          const after = await handler(
            new Request(`http://127.0.0.1:7737${url}`),
          );
          const shown = ((await after.json()) as { text: string }).text;
          if (url.includes("/dossiers/")) {
            expect(shown).toContain(next.trim());
          } else {
            expect(shown).toBe(next);
          }
        }
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST archive files a dossier and GET still finds it", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          pell:
            "---\nname: Pell\naliases: []\nkind: person\n---\nA locksmith.\n",
        },
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const headers = {
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
          "content-type": "application/json",
        };
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers/pell/archive", {
            method: "POST",
            headers,
            body: JSON.stringify({ archive: true }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          slug: string;
          archived: boolean;
          moved: boolean;
        };
        expect(body.slug).toBe("pell");
        expect(body.archived).toBe(true);
        expect(body.moved).toBe(true);
        const shown = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers/pell"),
        );
        expect(shown.status).toBe(200);
        const leaf = (await shown.json()) as {
          text: string;
          archived?: boolean;
        };
        expect(leaf.archived).toBe(true);
        expect(leaf.text).toContain("locksmith");
        const index = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers"),
        );
        const listed = (await index.json()) as {
          entries: Array<{ slug: string; archived?: boolean }>;
        };
        expect(listed.entries.find((e) => e.slug === "pell")?.archived).toBe(
          true,
        );
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT inspect refuses yaml and .nq; POST bad slug is 400", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { CAMPAIGN_YAML, PLAY_STATE_JSON } = await import(
        "../../src/campaign/index.ts"
      );
      const yamlBefore = await Bun.file(`${campaign}/${CAMPAIGN_YAML}`).text();
      const { handler, dispose } = await boot(campaign);
      try {
        const headers = {
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
          "If-Match": "anything",
        };
        for (const url of [
          "/api/inspect/yaml",
          "/api/inspect/campaign.yaml",
          "/api/inspect/.nq",
          `/api/inspect/${PLAY_STATE_JSON}`,
        ]) {
          const res = await handler(
            new Request(`http://127.0.0.1:7737${url}`, {
              method: "PUT",
              headers,
              body: "nope",
            }),
          );
          expect(res.status).toBe(404);
        }
        expect(await Bun.file(`${campaign}/${CAMPAIGN_YAML}`).text()).toBe(
          yamlBefore,
        );
        const bad = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/dossiers", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ slug: "Kell Brine" }),
          }),
        );
        expect(bad.status).toBe(400);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("PUT /api/inspect without Origin is 403", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/inspect/sheet", {
            method: "PUT",
            headers: { Host: "127.0.0.1:7737", "If-Match": "x" },
            body: "nope",
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/hygiene idle light is 202 and commits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the hidden pass really writes memory through the Campaign `write` tool
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("write", { path: "story-beats.md", content: "- http hygiene\n" }),
          says("discard"),
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const before = await listCampaignHistory(campaign);
        const eventResponse = await handler(
          new Request("http://127.0.0.1:7737/api/events"),
        );
        const eventReader = eventResponse.body!.getReader();
        await eventReader.read(); // initial kernel snapshot
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ mode: "light" }),
          }),
        );
        expect(res.status).toBe(202);
        const decoder = new TextDecoder();
        let pending = "";
        let hygieneEnded = false;
        let maintenanceComplete = false;
        while (!maintenanceComplete) {
          const chunk = await eventReader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as { type?: string };
            if (event.type === "hygiene_ended") hygieneEnded = true;
            if (hygieneEnded && event.type === "context") {
              maintenanceComplete = true;
            }
          }
        }
        await eventReader.cancel();
        expect(maintenanceComplete).toBe(true);
        const ps = await loadPlayState(campaign);
        expect(ps.last_hygiene_status).toBe("ok");
        expect(ps.last_hygiene_mode).toBe("light");
        expect(await Bun.file(`${campaign}/story-beats.md`).text()).toContain(
          "http hygiene",
        );
        const after = await listCampaignHistory(campaign);
        expect(after).toHaveLength(before.length + 1);
        expect(after[0]?.message).toBe("light");
        expect(instruction(gm.calls[0]!)).toStartWith(
          "[Memory Hygiene — light — hidden system pass]",
        );
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/hygiene while Turning is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        fallback: (c) =>
          isHygiene(c) ? c.say("should not hygiene") : untilStopped(entered)(c),
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I wait at the well." }),
          }),
        );
        expect(first.status).toBe(202);
        await entered.promise;
        const hygiene = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ mode: "heavy" }),
          }),
        );
        expect(hygiene.status).toBe(409);
        expect(gm.calls.filter(isHygiene)).toHaveLength(0);
        const stop = await handler(
          new Request("http://127.0.0.1:7737/api/interrupt", {
            method: "POST",
            headers: { Origin: ORIGIN, Host: "127.0.0.1:7737" },
          }),
        );
        expect(stop.status).toBe(204);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/hygiene compact success rebuilds and commits compact", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          (c) => c.tool("write", { path: "story-beats.md", content: "- http compact\n" }),
          says("heavy ok"),
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const before = await listCampaignHistory(campaign);
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ mode: "compact" }),
          }),
        );
        expect(res.status).toBe(202);
        await waitForLoopIdle(handler);
        const ps = await loadPlayState(campaign);
        expect(ps.last_hygiene_status).toBe("ok");
        expect(ps.last_hygiene_mode).toBe("heavy");
        expect(await Bun.file(`${campaign}/story-beats.md`).text()).toContain(
          "http compact",
        );
        const after = await listCampaignHistory(campaign);
        expect(after).toHaveLength(before.length + 1);
        expect(after[0]?.message).toBe("compact");
        expect(instruction(gm.calls[0]!)).toStartWith(
          "[Memory Hygiene — heavy — hidden system pass]",
        );
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/hygiene compact aborts when heavy fails; no rebuild commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      // the model call for the heavy pass fails at the provider
      const gm = await scriptedGameMaster({
        steps: [
          () => {
            throw new Error("heavy failed");
          },
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const before = await listCampaignHistory(campaign);
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ mode: "compact" }),
          }),
        );
        expect(res.status).toBe(202);
        await waitForLoopIdle(handler);
        const ps = await loadPlayState(campaign);
        expect(ps.last_hygiene_status).toBe("fail");
        expect(ps.last_hygiene_error).toBe("heavy failed");
        expect(ps.last_hygiene_mode).toBe("heavy");
        expect(ps.last_hygiene_transcript_line).toBeUndefined();
        expect(await listCampaignHistory(campaign)).toEqual(before);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("two overlapping POST /api/hygiene cannot both return 202", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const gm = await scriptedGameMaster({
        steps: [
          async (c) => {
            entered.resolve();
            await release.promise;
            c.say("ok");
          },
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const req = () =>
          handler(
            new Request("http://127.0.0.1:7737/api/hygiene", {
              method: "POST",
              headers,
              body: JSON.stringify({ mode: "light" }),
            }),
          );
        const [a, b] = await Promise.all([req(), req()]);
        expect([a.status, b.status].sort()).toEqual([202, 409]);
        await entered.promise;
        release.resolve();
        await waitForLoopIdle(handler);
        expect((await loadPlayState(campaign)).last_hygiene_status).toBe("ok");
        // only the accepted request ran a hidden pass
        expect(gm.calls.filter(isHygiene)).toHaveLength(1);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST /api/hygiene without Origin is 403; bad mode is 400", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const { handler, dispose } = await boot(campaign);
      try {
        const denied = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers: { "content-type": "application/json", Host: "127.0.0.1:7737" },
            body: JSON.stringify({ mode: "light" }),
          }),
        );
        expect(denied.status).toBe(403);
        const headers = {
          "content-type": "application/json",
          Origin: ORIGIN,
          Host: "127.0.0.1:7737",
        };
        const missing = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          }),
        );
        expect(missing.status).toBe(400);
        const bad = await handler(
          new Request("http://127.0.0.1:7737/api/hygiene", {
            method: "POST",
            headers,
            body: JSON.stringify({ mode: "vacuum" }),
          }),
        );
        expect(bad.status).toBe(400);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("GET /api/history is turn + short prose, not SHAs", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Brinewatch\n\n## Opening message\n\nMira Venn watches you from the Salt Lamp doorway.\n",
      });
      const { handler, dispose } = await boot(campaign);
      try {
        const first = await handler(
          new Request("http://127.0.0.1:7737/api/history"),
        );
        expect(first.status).toBe(200);
        const opening = (await first.json()) as {
          entries: Array<{ turn: number; prose: string }>;
        };
        expect(opening.entries).toEqual([
          {
            turn: 0,
            prose: "Mira Venn watches you from the Salt Lamp doorway.",
          },
        ]);
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I nod to Mira." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForTranscript(campaign, (rows) => rows.length >= 3);
        // the Turn's commit (what history lists) lands after its reply row
        await waitForLoopIdle(handler);
        const after = await handler(
          new Request("http://127.0.0.1:7737/api/history"),
        );
        const body = (await after.json()) as {
          entries: Array<{ turn: number; prose: string }>;
        };
        expect(body.entries.map((e) => e.turn)).toEqual([0, 1]);
        expect(body.entries[1]?.prose).toContain("Mira looks at your hands");
        expect(JSON.stringify(body)).not.toMatch(/"oid"|[a-f0-9]{40}/);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("GET /api/scratch returns the joinable record after SUCCESS", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("Need a dossier.");
            c.tool("read", { path: "player_sheet.md" });
          },
          says("Fog parts. A path appears."),
        ],
      });
      const { handler, dispose } = await boot(campaign, gm);
      try {
        const turn = await handler(
          new Request("http://127.0.0.1:7737/api/turn", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: ORIGIN,
              Host: "127.0.0.1:7737",
            },
            body: JSON.stringify({ text: "I step forward." }),
          }),
        );
        expect(turn.status).toBe(202);
        await waitForTranscript(campaign, (rows) =>
          rows.some((r) => r.role === "gm"),
        );
        // the scratch record is written just after the reply row
        await waitForLoopIdle(handler);
        const res = await handler(
          new Request("http://127.0.0.1:7737/api/scratch"),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          records: Array<{
            ts: string;
            turn: number;
            thinking: string;
            tools: Array<{ name: string; path?: string }>;
          }>;
        };
        expect(body.records).toHaveLength(1);
        expect(body.records[0]?.turn).toBe(1);
        expect(body.records[0]?.thinking).toBe("Need a dossier.");
        expect(body.records[0]?.tools).toEqual([
          { name: "read", path: "player_sheet.md" },
        ]);
        const rows = await readTranscript(campaign);
        expect(body.records[0]?.ts).toBe(rows.find((r) => r.role === "gm")?.ts);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });
});
