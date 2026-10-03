/**
 * Asks the relay which Game Master serves the book and wires the agent to
 * it: sealed calls to our own GPU worker (Runpod, or the owner's computer),
 * or plain calls to the relay's OpenRouter route (which sets the model and
 * privacy policy itself).
 */
import type { HostedAgentOptions } from "./agent.ts";
import { createSealedFetch } from "@nq/seal/browser.ts";

export async function connectGameMaster(opts: {
  /** The relay's base, e.g. https://nq.example/relay */
  relay: string;
  fetch: typeof fetch;
}): Promise<Pick<HostedAgentOptions, "transport" | "dialect" | "modelId">> {
  const relay = opts.relay.replace(/\/+$/, "");
  const config = (await (await opts.fetch(`${relay}/config`)).json()) as {
    backend?: string;
    workerKey?: string;
    model?: string;
  };
  if (config.backend === "openrouter") {
    return {
      dialect: "openai",
      ...(config.model ? { modelId: config.model } : {}),
      transport: (_path, init) =>
        opts.fetch(`${relay}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: init.body,
          signal: init.signal,
        }),
    };
  }
  if (config.backend === "unavailable") {
    throw new Error("The Game Master is offline right now. Try again later.");
  }
  if (!config.workerKey) throw new Error("the relay did not name a Game Master");
  return {
    dialect: "atomic",
    ...(config.model ? { modelId: config.model } : {}),
    transport: createSealedFetch({ relay, workerKey: config.workerKey, fetch: opts.fetch }),
  };
}
