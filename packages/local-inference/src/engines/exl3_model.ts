/**
 * EXL3 model folders (exllamav3, `mul1` codebook) as exl3xpu serves them:
 * reading a folder's config files, the model families NQ knows how to talk
 * to, and the assistant model that drafts for a backbone.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonObject } from "../files.ts";

/**
 * What vLLM needs to know per model family: its parsers, how its template
 * opens and closes a thought, the drafter method for its assistant model, and
 * whether it has sliding-window attention layers.
 */
type Exl3Family = {
  reasoningParser: string;
  toolParser: string;
  thinkingOpen: string;
  thinkingClose: string;
  drafter?: { modelType: string; method: string };
  slidingWindow?: boolean;
  /**
   * Token ids the drafter may propose (a file beside this module): its head
   * then reads a slice of the vocabulary instead of all of it. The target
   * verifies with its full head, so output is unchanged.
   */
  draftVocab?: string;
};

export const EXL3_FAMILIES: Readonly<Record<string, Exl3Family>> = {
  gemma4: {
    reasoningParser: "gemma4",
    toolParser: "gemma4",
    thinkingOpen: "<|channel>thought\n",
    thinkingClose: "\n<channel|>",
    drafter: { modelType: "gemma4_assistant", method: "gemma4_mtp" },
    // 50 of Gemma 4 31B's 60 layers attend to the last 1024 tokens only
    slidingWindow: true,
    // the ~11k tokens Twilight Embrace used across 69k tokens of story turns, ids below 8192,
    // and the special tokens (4.2% of the 262144-token vocabulary)
    draftVocab: "gemma4_draft_vocab.json",
  },
};

/** An EXL3 model folder NQ can serve, as read from its config files. */
export type Exl3Model = {
  directory: string;
  /** `model_type` of config.json, e.g. gemma4. */
  architecture: string;
  bits: number;
  tiedEmbeddings: boolean;
  hiddenSize?: number;
  vocabSize?: number;
  /** The model's own chat template, which NQ extends with its prefill hook. */
  chatTemplate?: string;
  /** generation_config.json sampling defaults, when the model ships them. */
  generation: Record<string, number>;
  size: number;
};

/**
 * Reads an EXL3 model folder: config.json plus quantization_config.json with
 * `quant_method: exl3`. Only the `mul1` codebook runs on exl3xpu's default
 * build, and only families NQ knows how to talk to are offered.
 */
export async function readExl3Model(
  directory: string,
): Promise<Exl3Model | undefined> {
  const quant = await readJsonObject(path.join(directory, "quantization_config.json"));
  if (quant?.quant_method !== "exl3" || quant.codebook !== "mul1") return undefined;
  const config = await readJsonObject(path.join(directory, "config.json"));
  const architecture = typeof config?.model_type === "string" ? config.model_type : "";
  if (!EXL3_FAMILIES[architecture]) return undefined;
  const text =
    config?.text_config && typeof config.text_config === "object"
      ? (config.text_config as Record<string, unknown>)
      : (config ?? {});
  const tied =
    config?.tie_word_embeddings === true || text.tie_word_embeddings === true;
  const templateText = await readFile(
    path.join(directory, "chat_template.jinja"),
    "utf8",
  ).catch(async () => {
    const tokenizer = await readJsonObject(path.join(directory, "tokenizer_config.json"));
    return typeof tokenizer?.chat_template === "string"
      ? tokenizer.chat_template
      : undefined;
  });
  const generationRaw =
    (await readJsonObject(path.join(directory, "generation_config.json"))) ?? {};
  const generation: Record<string, number> = {};
  for (const key of ["temperature", "top_k", "top_p", "min_p"]) {
    const value = generationRaw[key];
    if (typeof value === "number" && Number.isFinite(value)) generation[key] = value;
  }
  return {
    directory,
    architecture,
    bits: typeof quant.bits === "number" ? quant.bits : 0,
    tiedEmbeddings: tied,
    ...(typeof text.hidden_size === "number" ? { hiddenSize: text.hidden_size } : {}),
    ...(typeof text.vocab_size === "number" ? { vocabSize: text.vocab_size } : {}),
    ...(templateText ? { chatTemplate: templateText } : {}),
    generation,
    size: await directorySize(directory),
  };
}

/**
 * A drafter for `model` among `candidates`: an assistant model of the
 * family's drafter type built for this backbone (same hidden size and vocab).
 */
export async function findExl3Drafter(
  model: Exl3Model,
  candidates: readonly string[],
): Promise<string | undefined> {
  const family = EXL3_FAMILIES[model.architecture];
  if (!family?.drafter) return undefined;
  for (const directory of candidates) {
    const config = await readJsonObject(path.join(directory, "config.json"));
    if (config?.model_type !== family.drafter.modelType) continue;
    const text =
      config.text_config && typeof config.text_config === "object"
        ? (config.text_config as Record<string, unknown>)
        : {};
    if (model.hiddenSize !== undefined && config.backbone_hidden_size !== model.hiddenSize) {
      continue;
    }
    if (model.vocabSize !== undefined && text.vocab_size !== model.vocabSize) continue;
    return directory;
  }
  return undefined;
}

/** Folders holding a config.json, anywhere under `root`, for the model scan. */
export async function listModelFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "config.json")) {
      found.push(directory);
      return;
    }
    if (depth === 0) return;
    for (const entry of entries) {
      // work folders of conversions and caches start with a dot
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(path.join(directory, entry.name), depth - 1);
      }
    }
  };
  await walk(root, 2);
  return found.sort();
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(filename);
    else if (entry.isFile()) total += (await stat(filename)).size;
  }
  return total;
}
