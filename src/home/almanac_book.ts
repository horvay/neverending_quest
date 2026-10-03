/**
 * The Almanac as Home keeps it: the player's own sampler entries in
 * `almanac.json` beside the config, read fresh each time so a hand edit
 * counts, over the book's built-in entries.
 */
import type { NqConfig } from "../config.ts";
import {
  BUILT_IN_ALMANAC,
  entryChain,
  findEntry,
  newEntryId,
  parseAlmanacEntry,
  type AlmanacEntry,
  type ModelIdentity,
} from "@nq/local-inference/almanac.ts";
import { loadAlmanac, saveAlmanac } from "@nq/local-inference/almanac_store.ts";
import type { LocalTuning } from "@nq/local-inference/tuning.ts";
import { HomeError } from "./errors.ts";
import { LOCAL_PROVIDER_ID, listLocalModels } from "./providers.ts";

export type HomeAlmanac = {
  entries: AlmanacEntry[];
  models: Array<{
    selector: string;
    name: string;
    identity: ModelIdentity;
    sampling?: LocalTuning;
  }>;
};

export class AlmanacBook {
  constructor(
    private readonly configPath: string,
    /** Kept in step, so the next model warm-up reads the player's entries. */
    private readonly config: NqConfig,
    private readonly onChange: () => void,
  ) {}

  /** The player's entries first, then the book's, and every installed model. */
  async read(): Promise<HomeAlmanac> {
    const yours = await this.yours();
    const models = await listLocalModels().catch(() => []);
    return {
      entries: [...yours, ...BUILT_IN_ALMANAC],
      models: models.map((model) => ({
        selector: `${LOCAL_PROVIDER_ID}/${model.id}`,
        name: model.name,
        identity: model.identity,
        ...(model.sampling ? { sampling: model.sampling } : {}),
      })),
    };
  }

  /**
   * Writes one of the player's entries, new or edited. An entry without an id
   * is new and gets one from its title. Returns the stored entry.
   */
  async save(raw: unknown): Promise<AlmanacEntry> {
    const yours = await this.yours();
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) throw new HomeError("settings", "Give the entry a title.");
    const existing =
      typeof record.id === "string" && record.id
        ? yours.find((entry) => entry.id === record.id)
        : undefined;
    if (typeof record.id === "string" && record.id && !existing) {
      throw new HomeError("settings", "That entry is not one of yours.");
    }
    record.id = existing?.id ?? newEntryId(title, yours);
    const entry = parseAlmanacEntry(record);
    if (!entry) throw new HomeError("settings", "That entry could not be read.");
    if (entry.extends) {
      const parent = findEntry(entry.extends, yours);
      if (!parent) throw new HomeError("settings", "The entry it is built on is missing.");
      const others = yours.filter((item) => item.id !== entry.id);
      if (entryChain(parent, [...others, entry]).some((link) => link.id === entry.id)) {
        throw new HomeError("settings", "An entry cannot be built on itself.");
      }
    }
    if (!entry.match.names?.length && !entry.match.architecture?.length && !entry.extends) {
      throw new HomeError(
        "settings",
        "Say which models the entry is for, or what it is built on.",
      );
    }
    const next = existing
      ? yours.map((item) => (item.id === entry.id ? entry : item))
      : [entry, ...yours];
    await saveAlmanac(this.configPath, next);
    this.config.almanac = next;
    this.onChange();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const yours = await this.yours();
    if (!yours.some((entry) => entry.id === id)) {
      throw new HomeError("settings", "That entry is not one of yours.");
    }
    const next = yours
      .filter((entry) => entry.id !== id)
      // entries built on the deleted one fall back to what it was built on
      .map((entry) => {
        if (entry.extends !== id) return entry;
        const gone = yours.find((item) => item.id === id);
        const { extends: _parent, ...rest } = entry;
        return gone?.extends ? { ...rest, extends: gone.extends } : rest;
      });
    await saveAlmanac(this.configPath, next);
    this.config.almanac = next;
    this.onChange();
  }

  /** Read from disk each time, so a hand edit of almanac.json takes effect. */
  async yours(): Promise<AlmanacEntry[]> {
    const yours = await loadAlmanac(this.configPath);
    this.config.almanac = yours;
    return yours;
  }
}
