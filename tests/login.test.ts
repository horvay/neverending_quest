import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  configureNqLogin,
  parseOmpModels,
  parseOmpProviders,
} from "../src/login.ts";
import { makeTempDir, rmTempDir } from "./helpers/fs.ts";

/**
 * `nq login` shells out to the OMP CLI (external) for the provider list,
 * the browser sign-in, and the model catalog, and asks the terminal to pick.
 * Only those are faked: the CLI's raw JSON goes through our real parsers and
 * the real login flow writes the real NQ config.
 */
const OMP_PROVIDERS_JSON = JSON.stringify([
  { id: "xai-oauth", name: "xAI Grok OAuth" },
  { id: "openai-codex", name: "ChatGPT Codex" },
  { id: 42, name: "not a provider" },
]);

const OMP_MODELS_JSON = JSON.stringify({
  models: [
    {
      provider: "xai-oauth",
      selector: "xai-oauth/grok-4.5",
      name: "Grok 4.5",
    },
    {
      provider: "openai-codex",
      selector: "openai-codex/gpt-5.6-terra",
      name: "GPT 5.6 Terra",
    },
    { provider: "openai-codex", name: "missing selector" },
  ],
});

describe("NQ login", () => {
  test("picks a Provider and Model from OMP's catalogs and persists only the NQ model", async () => {
    const root = await makeTempDir();
    try {
      const configPath = path.join(root, "nq", "config.toml");
      const prompts: Array<{ prompt: string; options: unknown }> = [];
      const signedIn: string[] = [];
      const result = await configureNqLogin({
        configPath,
        providers: async () => parseOmpProviders(OMP_PROVIDERS_JSON),
        authenticate: async (provider) => {
          signedIn.push(provider);
        },
        models: async () => parseOmpModels(OMP_MODELS_JSON),
        choose: async (prompt, options) => {
          prompts.push({ prompt, options });
          return prompt === "Choose a Provider:"
            ? "xai-oauth"
            : "xai-oauth/grok-4.5";
        },
      });

      expect(result).toEqual({
        provider: "xai-oauth",
        model: "xai-oauth/grok-4.5",
      });
      expect(signedIn).toEqual(["xai-oauth"]);
      // malformed catalog rows are dropped; models are filtered to the provider
      expect(prompts).toEqual([
        {
          prompt: "Choose a Provider:",
          options: [
            { value: "xai-oauth", label: "xAI Grok OAuth" },
            { value: "openai-codex", label: "ChatGPT Codex" },
          ],
        },
        {
          prompt: "Choose a Game Master model:",
          options: [{ value: "xai-oauth/grok-4.5", label: "Grok 4.5" }],
        },
      ]);
      expect(await Bun.file(configPath).text()).toBe(
        'model = "xai-oauth/grok-4.5"\n',
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("an explicit Provider skips the picker, and a login alias maps to its model provider", async () => {
    const root = await makeTempDir();
    try {
      const configPath = path.join(root, "nq.toml");
      const result = await configureNqLogin({
        configPath,
        provider: "openai-codex-device",
        providers: async () => {
          throw new Error("provider picker should not run");
        },
        authenticate: async (provider) => {
          expect(provider).toBe("openai-codex-device");
        },
        models: async () => parseOmpModels(OMP_MODELS_JSON),
        choose: async (_prompt, options) => options[0]!.value,
      });

      expect(result.model).toBe("openai-codex/gpt-5.6-terra");
      expect(await Bun.file(configPath).text()).toBe(
        'model = "openai-codex/gpt-5.6-terra"\n',
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("broken OMP output fails with a player-readable reason", async () => {
    const root = await makeTempDir();
    try {
      const run = (models: string, providers = OMP_PROVIDERS_JSON) =>
        configureNqLogin({
          configPath: path.join(root, "nq.toml"),
          providers: async () => parseOmpProviders(providers),
          authenticate: async () => {},
          models: async () => parseOmpModels(models),
          choose: async (_prompt, options) => options[0]!.value,
        });
      await expect(run("[]")).rejects.toThrow(
        "OMP returned an invalid model list.",
      );
      await expect(run('{"models":[]}')).rejects.toThrow(
        "No models are available for provider: xai-oauth",
      );
      await expect(run(OMP_MODELS_JSON, "[]")).rejects.toThrow(
        "OMP returned no login providers.",
      );
      expect(await Bun.file(path.join(root, "nq.toml")).exists()).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });
});
