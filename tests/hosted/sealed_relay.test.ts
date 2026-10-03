import { afterEach, expect, test } from "bun:test";
import { RELAY_ORIGIN, startHostedStack, type HostedStack } from "../helpers/hosted_stack.ts";

/**
 * The hosted book reaches the Game Master through a Cloudflare relay that
 * holds the Runpod key. Only the model is fake; the browser seal client, the
 * relay Worker and the GPU-side seal worker are the shipped code.
 */

let stack: HostedStack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

test("a sealed completion streams through the relay, which only ever carries ciphertext", async () => {
  stack = await startHostedStack({
    steps: [
      (call) => {
        call.think("The lighthouse keeper hesitates.");
        call.say("The lamp gutters, ");
        call.say("then catches.");
      },
      (call) => call.say(`second: ${call.prompt}`),
    ],
  });

  // the book learns the worker's public key from the relay, never the Runpod key
  const config = await (await stack.relayFetch(`${RELAY_ORIGIN}/relay/config`)).json();
  expect(config).toEqual({ backend: "runpod", workerKey: stack.env.WORKER_KEY });

  const sealed = stack.sealedFetch();
  const secretPrompt = "I ask the keeper about the drowned bell.";
  const res = await sealed("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen",
      stream: true,
      messages: [{ role: "user", content: secretPrompt }],
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("event-stream");
  const sse = await readAll(res);
  expect(sse).toContain("The lighthouse keeper hesitates.");
  expect(sse).toContain("The lamp gutters, ");
  expect(sse).toContain("[DONE]");

  // llama-server got the plaintext request the browser built
  expect(stack.llama.calls[0]!.prompt).toBe(secretPrompt);

  // everything past the browser was sealed: no prompt, thinking or prose in transit
  const wire = [...stack.seen.requests, ...stack.seen.responses].join("\n");
  expect(wire.length).toBeGreaterThan(0);
  for (const plain of [secretPrompt, "drowned bell", "lighthouse keeper", "lamp gutters", "chat/completions"]) {
    expect(wire).not.toContain(plain);
  }
  // the relay added the Runpod key; the browser never had it
  expect(stack.seen.authorizations.every((a) => a === `Bearer ${stack!.apiKey}`)).toBe(true);

  // a GPU worker that restarted forgets the session; the client handshakes again
  await stack.restartWorker();
  const again = await sealed("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen", stream: true, messages: [{ role: "user", content: "hello again" }] }),
  });
  expect(await readAll(again)).toContain("second: hello again");

  // the relay forwards only the wake probe and the two sealed calls
  expect((await stack.relayFetch(`${RELAY_ORIGIN}/relay/v1/chat/completions`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await stack.relayFetch(`${RELAY_ORIGIN}/relay/ping`)).status).toBe(200);
});

test("a worker that cannot prove the pinned identity is refused before anything is sent", async () => {
  stack = await startHostedStack();
  const { createSealedFetch } = await import("@nq/seal/browser.ts");
  const { generateSealIdentity } = await import("@nq/seal/protocol.ts");
  const impostorPin = generateSealIdentity().publicKey;
  const sealed = createSealedFetch({
    relay: `${RELAY_ORIGIN}/relay`,
    workerKey: impostorPin,
    fetch: stack.relayFetch as typeof fetch,
  });
  await expect(
    sealed("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "secret plan" }] }),
    }),
  ).rejects.toThrow("pinned identity");
  expect(stack.llama.calls).toHaveLength(0);
  expect(stack.seen.requests.join("")).not.toContain("secret plan");
});
