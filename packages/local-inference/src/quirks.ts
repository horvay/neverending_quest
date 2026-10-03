/**
 * Per-model special cases, in one place. Everything else in this package
 * treats models alike; a model that needs something different gets a row
 * here, keyed by its GGUF `general.architecture`, never by its filename:
 * files are renamed freely (quantizers, merges, `nq local install --alias`),
 * the header is what llama.cpp itself dispatches on.
 *
 * A row says what to do, and why, so the launch code only reads flags.
 */

export type ModelQuirks = {
  /** KV cache type for both K and V, over the profile's and over the f16 fallback without flash attention. */
  kvCacheType?: string;
  /** VRAM headroom (MiB) that replaces the player's. */
  fitTargetMiB?: number;
  /** VRAM headroom (MiB) the player's is raised to. */
  minFitTargetMiB?: number;
  /** Tokens an embedded-MTP draft proposes (`--spec-draft-n-max`); 2 otherwise. */
  mtpDraftTokens?: number;
  /** llama.cpp keeps K and V in one cache, so -ctk and -ctv must match. */
  sharedKvCache?: boolean;
  /** `nextn_predict_layers` counts only when the file carries the NextN block itself. */
  mtpNeedsNextnBlock?: boolean;
  /** Embedded MTP is LongCat's replicated module under `<arch>.mtp.*`, not NextN layers. */
  longcatMtp?: boolean;
};

const QUIRKS: ReadonlyArray<{ architecture: RegExp; quirks: ModelQuirks }> = [
  {
    // LongCat Flash (and its sparse variant) loads in Atomic only on bf16
    // caches, needs far more VRAM headroom than the default leaves, and drafts
    // one token per step with its replicated MTP module.
    architecture: /^longcat-flash/,
    quirks: {
      kvCacheType: "bf16",
      fitTargetMiB: 1024,
      mtpDraftTokens: 1,
      longcatMtp: true,
    },
  },
  {
    // DeepSeek-V4: its graph is large enough that instantiating its CUDA graph
    // runs the card out of memory mid-prompt on the default headroom. Like an
    // MLA model, llama.cpp gives it one KV cache. Its loader drops MTP when the
    // NextN block is absent, as in REAP-pruned files that keep
    // `nextn_predict_layers` but ship no MTP weights.
    architecture: /^deepseek4$/,
    quirks: {
      minFitTargetMiB: 1024,
      sharedKvCache: true,
      mtpNeedsNextnBlock: true,
    },
  },
];

/** The special cases for a model, by its GGUF architecture; none when unknown. */
export function modelQuirks(architecture: string | undefined): ModelQuirks {
  if (!architecture) return {};
  const quirks: ModelQuirks = {};
  for (const row of QUIRKS) {
    if (row.architecture.test(architecture)) Object.assign(quirks, row.quirks);
  }
  return quirks;
}
