import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type OmpProvider = {
  id: string;
  name: string;
};

export type OmpModel = {
  provider: string;
  selector: string;
  name: string;
};

export type LoginChoice = {
  value: string;
  label: string;
};

// OMP 17.0.9's device-code login stores ChatGPT credentials for the Codex
// model provider rather than its own login-provider id.
const MODEL_PROVIDER_BY_LOGIN_PROVIDER: Readonly<Record<string, string>> = {
  "openai-codex-device": "openai-codex",
};

export type ConfigureNqLoginOptions = {
  configPath: string;
  provider?: string;
  providers: () => Promise<OmpProvider[]>;
  authenticate: (provider: string) => Promise<void>;
  models: () => Promise<OmpModel[]>;
  choose: (prompt: string, options: LoginChoice[]) => Promise<string>;
  prepareModel?: (model: string) => Promise<void>;
};

export type LoginResult = {
  provider: string;
  model: string;
};

/**
 * Runs the provider login and records the selected model in NQ's config.
 * Authentication stays entirely in OMP's credential vault.
 */
export async function configureNqLogin(
  opts: ConfigureNqLoginOptions,
): Promise<LoginResult> {
  let provider = opts.provider;
  if (!provider) {
    const providers = await opts.providers();
    provider = await opts.choose(
      "Choose a Provider:",
      providers.map((item) => ({ value: item.id, label: item.name })),
    );
  }

  await opts.authenticate(provider);

  const modelProvider =
    MODEL_PROVIDER_BY_LOGIN_PROVIDER[provider] ?? provider;
  const models = (await opts.models()).filter(
    (item) => item.provider === modelProvider,
  );
  if (models.length === 0) {
    throw new Error(`No models are available for provider: ${provider}`);
  }

  const model = await opts.choose(
    "Choose a Game Master model:",
    models.map((item) => ({ value: item.selector, label: item.name })),
  );
  if (!models.some((item) => item.selector === model)) {
    throw new Error(`Model is not available from ${provider}: ${model}`);
  }

  await opts.prepareModel?.(model);
  await saveNqModel(opts.configPath, model);
  return { provider, model };
}

export function parseOmpProviders(raw: string): OmpProvider[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("OMP returned an invalid provider list.");
  const providers = parsed.flatMap((item): OmpProvider[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      return [];
    }
    return [{ id: item.id, name: item.name }];
  });
  if (providers.length === 0) throw new Error("OMP returned no login providers.");
  return providers;
}

export function parseOmpModels(raw: string): OmpModel[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new Error("OMP returned an invalid model list.");
  }
  return parsed.models.flatMap((item): OmpModel[] => {
    if (
      !isRecord(item) ||
      typeof item.provider !== "string" ||
      typeof item.selector !== "string" ||
      typeof item.name !== "string"
    ) {
      return [];
    }
    return [
      { provider: item.provider, selector: item.selector, name: item.name },
    ];
  });
}

export async function saveNqModel(configPath: string, model: string): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // A new NQ config is expected on first login.
  }

  const modelLine = `model = ${JSON.stringify(model)}`;
  const firstTable = raw.search(/^\s*\[/m);
  const root = firstTable < 0 ? raw : raw.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : raw.slice(firstTable);
  const existing = /^\s*model\s*=.*$/m;
  const nextRoot = existing.test(root)
    ? root.replace(existing, modelLine)
    : `${modelLine}\n${root}`;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${nextRoot}${rest}`, "utf8");
}

export async function saveNqReasoning(
  configPath: string,
  reasoning: string,
): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // A new NQ config is expected on first login.
  }

  const reasoningLine = `reasoning = ${JSON.stringify(reasoning)}`;
  const firstTable = raw.search(/^\s*\[/m);
  const root = firstTable < 0 ? raw : raw.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : raw.slice(firstTable);
  const existing = /^\s*reasoning\s*=.*$/m;
  const nextRoot = existing.test(root)
    ? root.replace(existing, reasoningLine)
    : `${reasoningLine}\n${root}`;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${nextRoot}${rest}`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
