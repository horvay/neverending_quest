import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
  discoverAuthStorage,
  ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";
import type { HomeAuth, HomeModel, LoginHooks } from "./types.ts";
import { choicesFromOmpModel } from "./reasoning_catalog.ts";
import {
  listLocalModels,
  listOauthProvidersWithAuth,
  LOCAL_PROVIDER_ID,
  modelProviderId,
  providerDisplayName,
} from "./providers.ts";

export function playerPromptCopy(message: string): string {
  if (/llama\.cpp/i.test(message) || /local no-auth/i.test(message)) {
    return "If this computer needs a key, paste it. Otherwise leave this blank.";
  }
  if (/api key/i.test(message) || /paste your/i.test(message) && /key/i.test(message)) {
    return "Paste your key.";
  }
  if (/authorization code|redirect url/i.test(message)) {
    return "Paste the code from the browser.";
  }
  return sanitizePlayerCopy(message);
}

export function playerProgressCopy(message: string): string {
  if (/waiting for browser|waiting for .* authorization/i.test(message)) {
    return "Finish signing in in the browser.";
  }
  if (/validating/i.test(message)) return "Checking…";
  if (/exchanging/i.test(message)) return "Finishing sign-in…";
  return sanitizePlayerCopy(message);
}

export function sanitizePlayerCopy(raw: string): string {
  return raw
    .replace(/\bOAuth\b/gi, "sign-in")
    .replace(/\bauth-broker\b/gi, "")
    .replace(/\b[a-z0-9._-]+\/[a-z0-9._:+-]+\b/gi, "")
    .replace(/~[^\s]*/g, "")
    .replace(/(?:^|\s)(?:\/|\.)[^\s]*/g, " ")
    .replace(/\bconfig\.toml\b/gi, "")
    .replace(/\b(?:omp|pi-ai|pi-tui|xai-oauth|openai-codex|llama\.cpp|llama-cpp-local)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function createHomeAuth(opts?: {
  /**
   * OMP's model registry over its auth store. Production discovers the
   * player's own; tests hand in one over an in-memory store with a fake
   * provider registered, so sign-in and model listing stay offline.
   */
  registry?: ModelRegistry;
}): HomeAuth {
  const injected = opts?.registry;
  const withStorage = async <T>(
    use: (storage: AuthStorage) => Promise<T>,
  ): Promise<T> => {
    if (injected) return use(injected.authStorage);
    const storage = await discoverAuthStorage();
    try {
      return await use(storage);
    } finally {
      storage.close();
    }
  };
  return {
    listProviders: () => withStorage((s) => listOauthProvidersWithAuth(s)),
    login: (providerId, hooks) =>
      withStorage((s) => loginWith(s, providerId, hooks)),
    listModels: (providerId) =>
      listModelsWith(providerId, () =>
        withStorage((s) =>
          listLiveModels(s, injected, modelProviderId(providerId)),
        ),
      ),
  };
}

async function loginWith(
  storage: AuthStorage,
  providerId: string,
  hooks: LoginHooks,
): Promise<void> {
  await storage.login(providerId, {
    onAuth: (info) => {
      hooks.onAuth({
        url: info.url,
        launchUrl: info.launchUrl,
        instructions: info.instructions
          ? playerPromptCopy(info.instructions)
          : undefined,
      });
    },
    onPrompt: async (prompt) =>
      hooks.onPrompt({
        message: playerPromptCopy(prompt.message),
        allowEmpty: "allowEmpty" in prompt ? prompt.allowEmpty : undefined,
      }),
    onProgress: (message) => {
      hooks.onProgress(playerProgressCopy(message));
    },
    onManualCodeInput: () => hooks.onManualCodeInput(),
    signal: hooks.signal,
  });
}

async function listModelsWith(
  providerId: string,
  live: () => Promise<HomeModel[]>,
): Promise<HomeModel[]> {
  const modelProvider = modelProviderId(providerId);
  if (modelProvider === LOCAL_PROVIDER_ID) {
    const local = await listLocalModels();
    if (local.length > 0) {
      return local.map((m) => ({
        selector: `${LOCAL_PROVIDER_ID}/${m.id}`,
        name: m.name,
        ...(m.size !== undefined ? { size: m.size } : {}),
        // carries the saved projector so the picker reopens on it
        ...(m.mmproj ? { mmproj: m.mmproj } : {}),
        ...(m.sampling ? { sampling: m.sampling } : {}),
        identity: m.identity,
        ...(m.engine ? { engine: m.engine } : {}),
      }));
    }
    return [{ selector: `${LOCAL_PROVIDER_ID}/local`, name: "This computer" }];
  }
  const found = await live().catch(() => [] as HomeModel[]);
  if (found.length > 0) return found;
  try {
    const models = getBundledModels(
      modelProvider as Parameters<typeof getBundledModels>[0],
    );
    return models.map((m) => ({
      selector: `${m.provider}/${m.id}`,
      name: playerModelName(m.id, m.name),
      reasoning: choicesFromOmpModel(m),
    }));
  } catch {
    return [];
  }
}

async function listLiveModels(
  storage: AuthStorage,
  registry: ModelRegistry | undefined,
  modelProvider: string,
): Promise<HomeModel[]> {
  await storage.reload();
  const live = registry ?? new ModelRegistry(storage);
  await live.refreshProvider(modelProvider, "online");
  return live
    .getAvailable()
    .filter((m) => m.provider === modelProvider)
    .map((m) => ({
      selector: `${m.provider}/${m.id}`,
      name: playerModelName(m.id, m.name),
      reasoning: choicesFromOmpModel(m),
    }));
}

function playerModelName(id: string, name?: string): string {
  if (name && name !== id && !name.includes("/")) return name;
  if (/^grok-/i.test(id)) {
    return id.replace(/^grok-/i, "Grok ").replace(/-/g, " ");
  }
  return name || id;
}

export function modelDisplayName(selector: string, catalog?: HomeModel[]): string {
  const hit = catalog?.find((m) => m.selector === selector);
  if (hit) return hit.name;
  const slash = selector.lastIndexOf("/");
  const id = slash >= 0 ? selector.slice(slash + 1) : selector;
  return id;
}

export function signedInProviderName(providerId: string): string {
  return providerDisplayName(providerId);
}
