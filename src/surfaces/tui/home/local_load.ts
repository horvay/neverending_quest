/**
 * "This computer"'s load page in the terminal: the model, its engine profile
 * (pre-filled from the one saved for it, or the default NQ suggests), the
 * thinking level and temperament, engine downloads, then Load. The same
 * choices, wording and checks as the web book's load page; the surface
 * refuses what does not fit.
 */
import { LOCAL_TUNING_FIELDS, dropSavedFullProfile } from "@nq/local-inference/tuning.ts";
import type { HomeModel, HomeSnapshot, LocalModelSelection } from "../../../home/index.ts";
import { partialNumber, REASONING_LEVELS } from "../../../home/fields.ts";
import {
  CACHE_TYPES,
  engineName,
  formatModelSize,
  gpuKey,
  prefersPlainAttention,
} from "../../../home/local_load_page.ts";
import { AlmanacState } from "./almanac.ts";
import { type Field, FormScreen, NOT_A_NUMBER } from "./form.ts";
import { type HomeCtx, type HomeScreen, playerMessage, type View } from "./screen.ts";
import { readTemperament, type Temperament, temperamentField } from "./temperament.ts";

/**
 * What the load page remembers between openings in one sitting, as the web
 * book's browser does: the last model and thinking level, and the player's
 * own sampling values per model, as typed.
 */
export type LocalMemory = {
  model?: string;
  reasoning?: string;
  drafts: Record<string, Record<string, string>>;
};

export function localMemory(): LocalMemory {
  return { drafts: {} };
}


function sampleDrafts(drafts: Record<string, string>): Record<string, number> {
  const tuning: Record<string, number> = {};
  for (const [key, text] of Object.entries(drafts)) {
    const value = partialNumber(text);
    if (value !== undefined) tuning[key] = value;
  }
  return tuning;
}

export class LocalLoadScreen implements HomeScreen {
  private readonly form: FormScreen;
  private readonly almanac: AlmanacState;
  private model: string;
  private reasoning: string;
  private mmproj = "";
  private contextTokens = 0;
  private reasoningTokens = 0;
  private cacheK = "";
  private cacheV = "";
  private kvOffload = true;
  private flashAttention = true;
  /** gpuKey of the chosen card; "" is Automatic. */
  private gpu = "";
  private parallel = 1;
  private ramCacheGiB = 0;
  /** The engine build downloading now. */
  private downloading: string | null = null;

  constructor(
    private readonly ctx: HomeCtx,
    private readonly memory: LocalMemory,
  ) {
    const snap = ctx.snap();
    const models = snap.models ?? [];
    const settings = snap.settings;
    // the config's sampling values belong to the model it was saved with
    if (settings.model && !memory.drafts[settings.model]) {
      memory.drafts[settings.model] = Object.fromEntries(
        Object.entries(dropSavedFullProfile(settings.localTuning)).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
    }
    const pick =
      models.find((model) => model.selector === memory.model) ??
      models.find((model) => model.selector === settings.model) ??
      models[0];
    this.model = pick?.selector ?? "";
    this.reasoning = memory.reasoning ?? settings.reasoning;
    // fields the profile does not carry start from the global settings
    this.contextTokens = settings.localContextTokens;
    this.reasoningTokens = settings.localReasoningTokens;
    this.cacheK = settings.localCacheK;
    this.cacheV = settings.localCacheV;
    this.kvOffload = settings.localKvOffload;
    this.flashAttention = settings.localFlashAttention;
    this.gpu = this.listedGpu(snap, settings.localGpu);
    this.pickModel(snap, this.model);
    this.almanac = new AlmanacState(ctx);
    void this.almanac.load();
    this.form = new FormScreen(ctx, {
      heading: "This computer",
      status: () => "Choose the model and how much memory it may use.",
      fields: (current) => this.fields(current),
      back: () => this.cancel(),
    });
  }

  view(snap: HomeSnapshot): View {
    return {
      ...this.form.view(snap),
      hint: "↑↓ move · Enter change · Esc cancel",
    };
  }

  choose(value: string): Promise<void> {
    return this.form.choose(value);
  }

  back(): void {
    this.cancel();
  }

  private cancel(): void {
    this.ctx.surface.cancelLogin();
  }

  private selected(snap: HomeSnapshot): HomeModel | undefined {
    return (snap.models ?? []).find((model) => model.selector === this.model);
  }

  /** A card that is gone (unplugged, its engine removed) falls back to Automatic. */
  private listedGpu(
    snap: HomeSnapshot,
    wanted: { backend: string; device: string; name: string } | null | undefined,
  ): string {
    const gpus = snap.gpus?.gpus ?? [];
    return wanted && gpus.some((gpu) => gpuKey(gpu) === gpuKey(wanted)) ? gpuKey(wanted) : "";
  }

  /** Each model keeps its own projector and engine profile. */
  private pickModel(snap: HomeSnapshot, selector: string): void {
    this.model = selector;
    this.mmproj = this.selected(snap)?.mmproj ?? "";
    const profile = snap.localProfiles?.[selector]?.profile;
    if (!profile) return;
    this.contextTokens = profile.contextTokens;
    this.reasoningTokens = profile.reasoningTokens;
    this.cacheK = profile.cacheK;
    this.cacheV = profile.cacheV;
    this.kvOffload = profile.kvOffload;
    this.flashAttention = profile.flashAttention;
    this.gpu = this.listedGpu(snap, profile.gpu);
    this.parallel = profile.parallel;
    this.ramCacheGiB = profile.ramCacheGiB;
  }

  private drafts(): Record<string, string> {
    return (this.memory.drafts[this.model] ??= {});
  }

  private number(set: (value: number) => void): (text: string) => string | void {
    return (text) => {
      const value = partialNumber(text);
      if (value === undefined) return NOT_A_NUMBER;
      set(value);
    };
  }

  private fields(snap: HomeSnapshot): Field[] {
    const models = snap.models ?? [];
    const chosen = this.selected(snap);
    // EXL3 models run on exl3xpu, which picks the Intel GPU and its own attention
    const onExl3 = chosen?.engine === "exl3xpu";
    const exl3Ready = !onExl3 || snap.exl3xpu?.installed === true;
    const gpus = snap.gpus?.gpus ?? [];
    const downloadable = snap.gpus?.downloadable ?? [];
    const saved = snap.localProfiles?.[this.model]?.saved;
    const fields: Field[] = [
      {
        kind: "choice",
        key: "model",
        label: "Model",
        value: this.model,
        choices: models.map((model) => ({
          name: model.name,
          value: model.selector,
          description: [
            model.size !== undefined ? formatModelSize(model.size) : "",
            model.engine === "exl3xpu" ? "EXL3 on exl3xpu" : "",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        help: `${
          saved
            ? "Loads with the engine settings you last used for this model."
            : "New here: NQ suggests where this model runs, and keeps your choices for it."
        } NQ unloads the current model before loading a different one.`,
        set: (selector) => this.pickModel(this.ctx.snap(), selector),
      },
    ];

    if (onExl3) {
      fields.push({
        kind: "note",
        key: "exl3-note",
        label: "Runs on the Intel GPU with exl3xpu (vLLM)",
        help: "Drafting with the model's assistant when one is installed beside it.",
      });
      if (snap.exl3xpu?.installed) {
        // ready
      } else if (snap.exl3xpu?.downloading) {
        fields.push({ kind: "note", key: "exl3-progress", label: snap.exl3xpu.downloading });
      } else {
        fields.push({
          kind: "action",
          key: "exl3-download",
          label: "Download the exl3xpu engine",
          help: "About 8 GB once, 18 GB on disk. Needs bubblewrap (bwrap); no Docker.",
          run: () => this.download("exl3xpu"),
        });
      }
      if (snap.exl3xpu?.error) {
        fields.push({ kind: "note", key: "exl3-error", label: snap.exl3xpu.error });
      }
    } else if (gpus.length > 0 || downloadable.length > 0) {
      fields.push({
        kind: "choice",
        key: "gpu",
        label: "GPU",
        value: this.gpu,
        choices: [
          { name: "Automatic", value: "" },
          ...gpus.map((gpu) => ({
            name: `${gpu.name} — ${engineName(gpu.backend)}${
              gpu.memoryMiB !== undefined ? `, ${formatModelSize(gpu.memoryMiB * 1024 ** 2)}` : ""
            }`,
            value: gpuKey(gpu),
          })),
        ],
        help: "Automatic lets the installed engine use every card it can reach.",
        set: (key) => {
          this.gpu = key;
          const next = gpus.find((gpu) => gpuKey(gpu) === key);
          // each pick sets the attention that suits the card; the switch still wins
          this.flashAttention = !next || !prefersPlainAttention(next);
        },
      });
      for (const backend of downloadable) {
        const name = engineName(backend);
        fields.push({
          kind: "action",
          key: `download:${backend}`,
          label:
            this.downloading === backend
              ? `Downloading the ${name} engine…`
              : `Find more GPUs with ${name}`,
          help: `Downloads the ${name} engine, which runs on cards from any maker, beside the one you have.`,
          run: () => this.download(backend),
        });
      }
    }

    fields.push(
      {
        kind: "choice",
        key: "reasoning",
        label: "Thinking level",
        value: this.reasoning,
        choices: [
          ...(REASONING_LEVELS.includes(this.reasoning as (typeof REASONING_LEVELS)[number])
            ? []
            : [{ name: this.reasoning, value: this.reasoning }]),
          ...REASONING_LEVELS.map((level) => ({ name: level, value: level })),
        ],
        help: "How much the Game Master thinks before it answers. Many models want different settings with thinking off.",
        set: (level) => {
          this.reasoning = level;
        },
      },
      temperamentField(this.ctx, this),
    );

    if ((snap.mmproj ?? []).length > 0) {
      fields.push({
        kind: "choice",
        key: "mmproj",
        label: "Vision projector",
        value: this.mmproj,
        choices: [
          { name: "None", value: "" },
          ...(snap.mmproj ?? []).map((file) => ({
            name: file.name,
            value: file.path,
            description: file.size !== undefined ? formatModelSize(file.size) : "",
          })),
        ],
        help: "Loads an mmproj file so the Game Master can see images.",
        set: (path) => {
          this.mmproj = path;
        },
      });
    }

    fields.push(
      {
        kind: "text",
        key: "context",
        label: "Context window",
        text: String(this.contextTokens),
        unit: "tokens",
        help: "Higher values reserve more GPU memory.",
        set: this.number((value) => {
          this.contextTokens = value;
        }),
      },
      {
        kind: "text",
        key: "budget",
        label: "Reasoning budget",
        text: String(this.reasoningTokens),
        unit: "tokens",
        help: "Use -1 for unrestricted thinking.",
        set: this.number((value) => {
          this.reasoningTokens = value;
        }),
      },
    );

    // plain attention runs on f16 caches; exl3xpu keeps its own
    const cachesFixed = !this.flashAttention && !onExl3;
    const cacheField = (
      key: "cacheK" | "cacheV",
      label: string,
      help: string,
    ): Field =>
      cachesFixed
        ? {
            kind: "note",
            key,
            label: `${label}: f16`,
            help: "Both caches are f16 while flash attention is off.",
          }
        : {
            kind: "choice",
            key,
            label,
            value: this[key],
            choices: CACHE_TYPES.map((type) => ({ name: type, value: type })),
            help,
            set: (type) => {
              this[key] = type;
            },
          };
    fields.push(
      cacheField(
        "cacheK",
        "Key cache",
        "Keep q8_0, or try q4_0 for more context. A turbo key cache degrades models with few KV heads.",
      ),
      cacheField(
        "cacheV",
        "Value cache",
        `turbo3 frees about 1 GiB over q8_0 at a long context, at no measured cost in speed.${
          onExl3 ? " exl3xpu keeps f16 when both caches are f16, and fp8 for any other choice." : ""
        }`,
      ),
    );

    if (onExl3) {
      fields.push(
        {
          kind: "text",
          key: "parallel",
          label: "Games at once",
          text: String(this.parallel),
          help: "Requests the engine answers side by side, for players sharing this computer. They share the card's cache.",
          set: this.number((value) => {
            this.parallel = value;
          }),
        },
        {
          kind: "text",
          key: "ram-cache",
          label: "RAM cache",
          text: String(this.ramCacheGiB),
          unit: "GiB",
          help: "System RAM that keeps a waiting game's cache, so its next turn copies it back instead of re-reading the whole prompt. 0 turns it off. At most half your RAM; on Intel it rounds down to 8, 16 or 32 GiB.",
          set: this.number((value) => {
            this.ramCacheGiB = value;
          }),
        },
      );
    }

    const fitTarget = LOCAL_TUNING_FIELDS.find((field) => field.key === "fitTarget")!;
    fields.push({
      kind: "text",
      key: "fit-target",
      label: fitTarget.label,
      text: this.drafts().fitTarget ?? "",
      blank: String(fitTarget.fallback),
      placeholder: String(fitTarget.fallback),
      unit: "MiB",
      help: fitTarget.help,
      set: (text) => {
        if (text.trim() && partialNumber(text) === undefined) return NOT_A_NUMBER;
        this.drafts().fitTarget = text.trim();
      },
    });

    if (!onExl3) {
      fields.push(
        {
          kind: "switch",
          key: "kv-offload",
          label: "Keep the cache in system RAM",
          on: !this.kvOffload,
          help: "Frees card memory for the weights. Generation measured about four times slower.",
          set: (on) => {
            this.kvOffload = !on;
          },
        },
        {
          kind: "switch",
          key: "flash-attention",
          label: "Turn off flash attention",
          on: !this.flashAttention,
          help: "Much faster long prompts on Intel Arc, whose driver cannot run flash attention quickly. Both caches become f16, which takes more memory.",
          set: (on) => {
            this.flashAttention = !on;
          },
        },
      );
    }

    fields.push(
      {
        kind: "action",
        key: "load",
        label: "Load Game Master",
        help: exl3Ready ? "" : "Download the exl3xpu engine first.",
        run: () => this.load(exl3Ready),
      },
      { kind: "action", key: "cancel", label: "Cancel", run: () => this.cancel() },
    );
    return fields;
  }

  /** What Auto picks for the model being loaded; undefined until the Almanac is read. */
  temperament(): Temperament | undefined {
    return readTemperament(this.almanac, this.selected(this.ctx.snap()), this.reasoning);
  }

  /** The player's own sampling values for the model being loaded. */
  samplingDrafts(): Record<string, string> {
    return this.drafts();
  }

  private async download(backend: string): Promise<void> {
    if (this.downloading) return;
    this.downloading = backend;
    this.ctx.repaint();
    try {
      await this.ctx.surface.downloadLocalEngine(backend);
    } catch (error) {
      this.ctx.notice(playerMessage(error, `Could not download the ${engineName(backend)} engine.`));
    } finally {
      this.downloading = null;
      this.ctx.repaint();
    }
  }

  private async load(exl3Ready: boolean): Promise<void> {
    const snap = this.ctx.snap();
    if (!this.model) return;
    if (!exl3Ready) {
      this.ctx.notice("Download the exl3xpu engine first.");
      return;
    }
    const onExl3 = this.selected(snap)?.engine === "exl3xpu";
    const chosenGpu = (snap.gpus?.gpus ?? []).find((gpu) => gpuKey(gpu) === this.gpu);
    this.memory.model = this.model;
    this.memory.reasoning = this.reasoning;
    const selection: LocalModelSelection = {
      model: this.model,
      // only when the picker was shown, so loading a model never silently
      // clears a projector the page could not display
      ...((snap.mmproj ?? []).length > 0 ? { mmproj: this.mmproj } : {}),
      cacheK: this.cacheK,
      cacheV: this.cacheV,
      kvOffload: this.kvOffload,
      flashAttention: this.flashAttention,
      ...(onExl3 ? { parallel: this.parallel, ramCacheGiB: this.ramCacheGiB } : {}),
      ...(chosenGpu
        ? { gpu: { backend: chosenGpu.backend, device: chosenGpu.device, name: chosenGpu.name } }
        : {}),
      tuning: sampleDrafts(this.drafts()),
      contextTokens: this.contextTokens,
      reasoningTokens: this.reasoningTokens,
      reasoning: this.reasoning,
    };
    await this.ctx.surface.pickLocalModel(selection);
  }
}
