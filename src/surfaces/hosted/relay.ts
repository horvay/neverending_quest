/**
 * The hosted build's only backend: a Cloudflare Worker that serves the static
 * book and relays the Game Master's calls, adding a key the browser never
 * sees. Two backends, chosen by `GM_BACKEND`:
 *
 * - `runpod`: sealed calls to our own GPU worker behind the Runpod load
 *   balancer. The relay forwards ciphertext as-is; only the browser and the
 *   GPU worker can open it.
 * - `openrouter`: chat completions through OpenRouter. The relay sees the
 *   request, so it enforces the policy itself — the model, zero data
 *   retention, no training, an excluded-provider list and a token cap — and
 *   never reads further or logs a body.
 * - `local`: sealed calls to a seal worker on the owner's own computer,
 *   reached through a Workers VPC service binding over a Cloudflare Tunnel, so
 *   the computer has no public address. The relay adds a shared secret the
 *   worker checks. When the computer does not answer, the book gets OpenRouter
 *   instead (if it is configured).
 *
 * Plain Workers module syntax, so tests also call `fetch` in-process.
 */

export type RelayEnv = {
  /** Which Game Master serves the book: "runpod" (default) or "openrouter". */
  GM_BACKEND?: string;
  /** Runpod load-balancer base, e.g. https://<endpoint>.api.runpod.ai */
  RUNPOD_UPSTREAM?: string;
  /** Secret. Prefer a key restricted to this one endpoint. */
  RUNPOD_API_KEY?: string;
  /** The GPU worker's pinned Ed25519 public key, raw base64 (public). */
  WORKER_KEY?: string;
  /** Secret. Give it a credit limit on OpenRouter: it caps what the public book can spend. */
  OPENROUTER_API_KEY?: string;
  /** OpenRouter model id, e.g. qwen/qwen3.8-27b. */
  OPENROUTER_MODEL?: string;
  /** Providers never to route to, comma-separated (their terms ban the book's content). */
  OPENROUTER_IGNORE?: string;
  /** If set, the only providers to route to, comma-separated (their terms are known to fit). */
  OPENROUTER_ONLY?: string;
  /** Sampling for the model above (numbers as text); unset means the provider's default. */
  OPENROUTER_TEMPERATURE?: string;
  OPENROUTER_TOP_P?: string;
  /** API base; tests point it elsewhere. */
  OPENROUTER_BASE?: string;
  /** Workers VPC service binding to the seal worker on the owner's computer. */
  LOCAL_GM?: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** Secret the local seal worker requires, sent as a bearer token. */
  LOCAL_GM_TOKEN?: string;
  /** The local seal worker's pinned Ed25519 public key, raw base64 (public). */
  LOCAL_WORKER_KEY?: string;
  /** The local Game Master's name, shown in the book. */
  LOCAL_MODEL_NAME?: string;
  /** Static assets (the built book); absent when tests serve them. */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
};

// Workers may only export handlers, so these stay module-private.
const RELAY_PREFIX = "/relay";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
/** A Turn's reply plus capped thinking fits well inside this. */
const MAX_OUTPUT_TOKENS = 8192;
/** A Campaign prompt is tens of KB; anything this large is not the book. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EFFORTS = new Set(["low", "medium", "high"]);

/** The only Runpod routes: the wake probe and the two sealed calls. */
const RELAYED = new Map<string, string>([
  ["GET /ping", "/ping"],
  ["POST /.seal/hello", "/.seal/hello"],
  ["POST /.seal/call", "/.seal/call"],
]);

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "x-seal-session",
  "x-seal-seq",
];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"];

/** How long `/config` waits for the owner's computer before falling back. */
const LOCAL_PING_MS = 3000;

function backendOf(env: RelayEnv): "runpod" | "openrouter" | "local" {
  if (env.GM_BACKEND === "openrouter") return "openrouter";
  if (env.GM_BACKEND === "local") return "local";
  return "runpod";
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);
    const backend = backendOf(env);
    if (url.pathname === `${RELAY_PREFIX}/config` && request.method === "GET") {
      return Response.json(await configFor(backend, env), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === `${RELAY_PREFIX}/status` && request.method === "GET") {
      return Response.json(await statusFor(backend, env), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname.startsWith(`${RELAY_PREFIX}/`)) {
      const path = url.pathname.slice(RELAY_PREFIX.length);
      // OpenRouter serves the book, or stands in while the owner's computer is away
      if (request.method === "POST" && path === "/chat") {
        if (backend === "openrouter" || (backend === "local" && env.OPENROUTER_API_KEY)) {
          return openRouter(request, env);
        }
        return new Response("Not found", { status: 404 });
      }
      if (backend === "openrouter") return new Response("Not found", { status: 404 });
      const route = RELAYED.get(`${request.method} ${path}`);
      if (!route) return new Response("Not found", { status: 404 });
      return backend === "local" ? relayLocal(request, env, route) : relaySealed(request, env, route);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

/** Which Game Master a page that loads now should use. */
async function configFor(
  backend: "runpod" | "openrouter" | "local",
  env: RelayEnv,
): Promise<Record<string, unknown>> {
  const openRouterConfig = { backend: "openrouter", model: env.OPENROUTER_MODEL || DEFAULT_MODEL };
  if (backend === "openrouter") return openRouterConfig;
  if (backend === "runpod") return { backend, workerKey: env.WORKER_KEY };
  if (await localAnswers(env)) {
    return {
      backend,
      workerKey: env.LOCAL_WORKER_KEY,
      ...(env.LOCAL_MODEL_NAME ? { model: env.LOCAL_MODEL_NAME } : {}),
    };
  }
  return env.OPENROUTER_API_KEY ? openRouterConfig : { backend: "unavailable" };
}

/**
 * Whether the book's Game Master answers right now, for the page's status
 * badge. Only the owner's computer is pinged: a Runpod worker scales to zero,
 * and a status check must never wake (and bill) one.
 */
export type RelayStatus = {
  backend: "runpod" | "openrouter" | "local";
  /** "cloud" for a hosted backend the relay does not probe */
  host: "online" | "offline" | "cloud";
  /** OpenRouter stands in while the owner's computer is away */
  backup: boolean;
};

async function statusFor(
  backend: "runpod" | "openrouter" | "local",
  env: RelayEnv,
): Promise<RelayStatus> {
  if (backend !== "local") return { backend, host: "cloud", backup: false };
  return {
    backend,
    host: (await localAnswers(env)) ? "online" : "offline",
    backup: Boolean(env.OPENROUTER_API_KEY),
  };
}

/** True when the owner's seal worker is up and its Game Master is loaded. */
async function localAnswers(env: RelayEnv): Promise<boolean> {
  if (!env.LOCAL_GM || !env.LOCAL_WORKER_KEY) return false;
  try {
    const res = await env.LOCAL_GM.fetch("http://local-gm/ping", {
      headers: localAuth(env),
      signal: AbortSignal.timeout(LOCAL_PING_MS),
    });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

function localAuth(env: RelayEnv): Record<string, string> {
  return env.LOCAL_GM_TOKEN ? { authorization: `Bearer ${env.LOCAL_GM_TOKEN}` } : {};
}

async function relayLocal(request: Request, env: RelayEnv, route: string): Promise<Response> {
  if (!env.LOCAL_GM) return new Response("Game Master not configured", { status: 503 });
  const headers = new Headers(localAuth(env));
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await env.LOCAL_GM.fetch(`http://local-gm${route}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal,
    });
  } catch {
    return new Response("Game Master unreachable", { status: 502 });
  }
  return passThrough(res);
}

async function relaySealed(request: Request, env: RelayEnv, route: string): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.RUNPOD_API_KEY) headers.set("authorization", `Bearer ${env.RUNPOD_API_KEY}`);
  const upstream = (env.RUNPOD_UPSTREAM ?? "").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${upstream}${route}`, {
      method: request.method,
      headers,
      // sealed requests are small; a buffered body gets a Content-Length,
      // which every load balancer accepts
      ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal,
    });
  } catch {
    return new Response("Game Master unreachable", { status: 502 });
  }
  return passThrough(res);
}

/**
 * Only the conversation comes from the page. Everything that decides where
 * it goes, what may keep it and what it costs is set here.
 */
async function openRouter(request: Request, env: RelayEnv): Promise<Response> {
  if (!env.OPENROUTER_API_KEY) return new Response("Game Master not configured", { status: 503 });
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
  let asked: Record<string, unknown>;
  try {
    asked = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!Array.isArray(asked.messages)) return new Response("Bad request", { status: 400 });
  const effortAsked = (asked.reasoning as { effort?: unknown } | undefined)?.effort;
  const maxAsked = Number(asked.max_tokens);
  const list = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const ignore = list(env.OPENROUTER_IGNORE);
  const only = list(env.OPENROUTER_ONLY);
  // sampling belongs with the model, so it is the relay's setting, not the page's
  const temperature = Number.parseFloat(env.OPENROUTER_TEMPERATURE ?? "");
  const topP = Number.parseFloat(env.OPENROUTER_TOP_P ?? "");
  const body = {
    model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
    messages: asked.messages,
    ...(Array.isArray(asked.tools) && asked.tools.length > 0 ? { tools: asked.tools } : {}),
    stream: true,
    usage: { include: true },
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(topP) ? { top_p: topP } : {}),
    max_tokens: Number.isFinite(maxAsked) && maxAsked > 0 ? Math.min(maxAsked, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
    reasoning: { effort: typeof effortAsked === "string" && EFFORTS.has(effortAsked) ? effortAsked : "low" },
    // zero data retention and no training, whatever the page asked for
    provider: {
      zdr: true,
      data_collection: "deny",
      ...(ignore.length > 0 ? { ignore } : {}),
      // cheapest first among the allowed; the page cannot widen the list
      ...(only.length > 0 ? { only, sort: "price" } : {}),
    },
    ...(typeof asked.session_id === "string" && asked.session_id.length <= 256
      ? { session_id: asked.session_id }
      : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${(env.OPENROUTER_BASE || OPENROUTER_BASE).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "Neverending Quest",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch {
    return new Response("Game Master unreachable", { status: 502 });
  }
  return passThrough(res);
}

function passThrough(res: Response): Response {
  const out = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers: out });
}
