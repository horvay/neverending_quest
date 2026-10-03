import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  createLocalInferenceHostClient,
  runLocalInferenceHostProcess,
} from "@nq/local-inference/host.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { fakeLocalRuntime, reservePort } from "../helpers/local_runtime.ts";
import { startLocalHost } from "../helpers/local_host.ts";

describe("Local Inference Host", () => {
  test("exits on its own once no client holds a lease", async () => {
    const root = await makeTempDir();
    const enginePort = reservePort();
    try {
      // a host that outlives its clients keeps serving whatever code it loaded
      // at spawn, so an edit to the engine command line never takes effect
      const running = runLocalInferenceHostProcess({
        rootDir: root,
        port: 0,
        enginePort,
        token: "test-token",
        idleExitMs: 0,
        sweepMs: 10,
      });
      // it comes up and, with no lease ever taken, goes away by itself
      await running;
      expect(
        await Bun.file(path.join(root, "inference-host.json")).exists(),
      ).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("stays offline until requested, then exposes one stable control endpoint", async () => {
    const root = await makeTempDir();
    const port = 0;
    const enginePort = reservePort();
    const token = "test-token";
    try {
      const client = createLocalInferenceHostClient({
        rootDir: root,
        port,
        enginePort,
        clientPid: process.pid,
      });
      expect(await client.status()).toMatchObject({
        hostRunning: false,
        phase: "idle",
        clients: 0,
        pinned: false,
      });

      const running = runLocalInferenceHostProcess({
        rootDir: root,
        port,
        enginePort,
        token,
      });
      await waitForFile(path.join(root, "inference-host.json"));

      expect(await client.status()).toMatchObject({
        hostRunning: true,
        phase: "idle",
        clients: 0,
        pinned: false,
      });
      const record = JSON.parse(
        await Bun.file(path.join(root, "inference-host.json")).text(),
      ) as { port: number };
      expect(record.port).toBeGreaterThan(0);
      const modelResponse = await fetch(
        `http://127.0.0.1:${record.port}/v1/models`,
      );

      expect(modelResponse.status).toBe(503);

      await client.stop();
      await running;
      expect(
        await Bun.file(path.join(root, "inference-host.json")).exists(),
      ).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
  test("retires a host from an older protocol before reuse", async () => {
    const root = await makeTempDir();
    const token = "stale-token";
    let stopCalled = false;
    // a host left running by an older NQ: same product, no protocol stamp
    const stale: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/.nq/health") {
          return Response.json({
            product: "neverending-quest-local-inference",
            pid: process.pid,
          });
        }
        if (
          url.pathname === "/.nq/stop" &&
          request.headers.get("authorization") === `Bearer ${token}`
        ) {
          stopCalled = true;
          // graceful: the 202 still reaches the client, then the port closes
          queueMicrotask(() => void stale.stop());
          return new Response(null, {
            status: 202,
            headers: { connection: "close" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    try {
      await Bun.write(
        path.join(root, "inference-host.json"),
        `${JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: stale.port,
          enginePort: reservePort(),
          token,
          startedAt: new Date(0).toISOString(),
        })}\n`,
      );
      const client = createLocalInferenceHostClient({
        rootDir: root,
        enginePort: reservePort(),
      });
      expect(await client.status()).toMatchObject({
        hostRunning: false,
        phase: "idle",
      });
      expect(stopCalled).toBe(true);
      expect(
        await Bun.file(path.join(root, "inference-host.json")).exists(),
      ).toBe(false);
    } finally {
      stale.stop(true);
      await rmTempDir(root);
    }
  });
  test("ends only the active completion owned by the requesting client", async () => {
    const root = await makeTempDir();
    const enginePort = reservePort();
    const token = "reasoning-test-token";
    let closeChat: (() => void) | undefined;
    let chatClosed = false;
    let chatBody: Record<string, unknown> | undefined;
    let controlBody: Record<string, unknown> | undefined;
    let closeResponses: (() => void) | undefined;
    let responsesClosed = false;
    let responsesBody: Record<string, unknown> | undefined;
    let responsesControlBody: Record<string, unknown> | undefined;
    // the real runtime manager "spawns" this engine when the host activates it
    const engine = await fakeLocalRuntime({
      rootDir: root,
      enginePort,
      alias: "local-model",
      engine: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/chat/completions") {
          chatBody = (await request.json()) as Record<string, unknown>;
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'data: {"id":"chatcmpl-active","choices":[{"delta":{"reasoning_content":"Checking memory."}}]}\n\n',
                  ),
                );
                closeChat = () => {
                  if (chatClosed) return;
                  chatClosed = true;
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                };
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/v1/chat/completions/control") {
          controlBody = (await request.json()) as Record<string, unknown>;
          return Response.json({ success: true });
        }
        if (url.pathname === "/responses") {
          responsesBody = (await request.json()) as Record<string, unknown>;
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-active","status":"in_progress"}}\n\n',
                  ),
                );
                closeResponses = () => {
                  if (responsesClosed) return;
                  responsesClosed = true;
                  controller.enqueue(
                    encoder.encode(
                      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-active","status":"completed"}}\n\n',
                    ),
                  );
                  controller.close();
                };
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/responses/control") {
          responsesControlBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return Response.json({ success: true });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const client = createLocalInferenceHostClient({
      rootDir: root,
      port: 0,
      enginePort,
      clientPid: process.pid,
    });
    const running = runLocalInferenceHostProcess({
      rootDir: root,
      port: 0,
      enginePort,
      token,
      runtime: engine.runtime,
    });
    try {
      await waitForFile(path.join(root, "inference-host.json"));
      await client.activate({ model: "local-model" });
      const record = JSON.parse(
        await Bun.file(path.join(root, "inference-host.json")).text(),
      ) as { port: number };
      const response = await fetch(
        `http://127.0.0.1:${record.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "local-model",
            messages: [{ role: "user", content: "Think." }],
            stream: true,
            reasoning_control: true,
            nq_client_pid: process.pid,
          }),
        },
      );
      const reader = response.body!.getReader();
      await reader.read();

      expect(chatBody).toMatchObject({
        reasoning_control: true,
        stream: true,
      });
      expect(chatBody).not.toHaveProperty("nq_client_pid");
      expect(await client.endReasoning()).toEqual({ success: true });
      expect(controlBody).toEqual({
        id: "chatcmpl-active",
        action: "reasoning_end",
      });

      closeChat?.();
      await reader.cancel();
      expect(await client.endReasoning()).toEqual({
        success: false,
        message: "No active local reasoning block.",
      });
      const responses = await fetch(
        `http://127.0.0.1:${record.port}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "local-model",
            input: [{ role: "user", content: "Think." }],
            stream: true,
            reasoning_control: true,
            nq_client_pid: process.pid,
          }),
        },
      );
      const responsesReader = responses.body!.getReader();
      await responsesReader.read();

      expect(responsesBody).toMatchObject({
        reasoning_control: true,
        stream: true,
      });
      expect(responsesBody).not.toHaveProperty("nq_client_pid");
      expect(await client.endReasoning()).toEqual({ success: true });
      expect(responsesControlBody).toEqual({
        id: "resp-active",
        action: "reasoning_end",
      });

      closeResponses?.();
      await responsesReader.cancel();
      await client.stop();
      await running;
      // the host started the engine for the lease and stopped it on the way out
      expect(engine.events).toEqual([
        `start:${enginePort}:local-model:${engine.spawns[0]![engine.spawns[0]!.indexOf("-c") + 1]}:${engine.spawns[0]![engine.spawns[0]!.indexOf("--reasoning-budget") + 1]}`,
        "stop",
      ]);
    } finally {
      closeChat?.();
      closeResponses?.();
      engine.shutdown();
      await rmTempDir(root);
    }
  });
});

describe("a restarted Local Inference Host", () => {
  // the load page's choices, none of them the defaults
  const profile = {
    contextTokens: 32_768,
    reasoningTokens: 2_048,
    cacheK: "q4_0",
    cacheV: "turbo4",
    tuning: { temperature: 0.6 },
    flashAttention: true,
  } as const;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  test("keeps serving on the engine a killed host left running when the same profile returns", async () => {
    const host = await startLocalHost({
      engine: { holdReasoning: false },
      leftRunning: profile,
    });
    try {
      expect(host.engine.spawns).toHaveLength(1);
      // the new host took the running engine over, profile and all
      expect(await host.client.status()).toMatchObject({
        phase: "game-master",
        activeProfile: { model: host.alias, cacheK: "q4_0", cacheV: "turbo4" },
      });

      // the Game Master warms the profile it was already playing on
      await host.client.activate({ model: host.alias, ...profile });
      expect(host.engine.spawns).toHaveLength(1);
      expect(host.engine.running()).toBe(true);

      // and a Turn still streams from that engine
      const response = await fetch(`${await host.endpoint()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: host.alias,
          messages: [{ role: "user", content: "Look around." }],
          stream: true,
        }),
      });
      expect(await response.text()).toContain("The tide turns.");
      expect(host.engine.completions).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  test("restarts an engine that died with the old host on the whole profile", async () => {
    const host = await startLocalHost({
      engine: { holdReasoning: false },
      leftRunning: profile,
      engineExited: true,
    });
    try {
      // the restored engine is the one the player chose, not Atomic's defaults
      expect(host.engine.spawns).toHaveLength(2);
      const args = host.engine.spawns[1]!;
      expect(flag(args, "-c")).toBe("32768");
      expect(flag(args, "--reasoning-budget")).toBe("2048");
      expect(flag(args, "-ctk")).toBe("q4_0");
      expect(flag(args, "-ctv")).toBe("turbo4");
      expect(flag(args, "--temp")).toBe("0.6");

      await host.client.activate({ model: host.alias, ...profile });
      expect(host.engine.spawns).toHaveLength(2);
    } finally {
      await host.stop();
    }
  });
});

async function waitForFile(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await Bun.file(target).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${target}`);
}
