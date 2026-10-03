import { isCampaignError } from "../../../campaign/errors.ts";
import { LEAF_TITLE } from "../../shared/leaves.ts";
import { toSlug } from "../../shared/text.ts";
import { BUSY, refusal } from "./copy.ts";
import type { TuiChromeHandlers } from "./handlers.ts";
import { leafWritable, type LeafView, type ReadView } from "./views.ts";

/** What Inspect needs from the chrome around it. */
export type InspectHost = {
  handlers: TuiChromeHandlers;
  /** The read view on screen, or under the ink overlay. */
  current(): ReadView | undefined;
  /** Put a view on screen, leaving any overlay. */
  show(view: ReadView): void;
  /** Update the view on screen without moving (not one under the ink). */
  refresh(view: ReadView): void;
  /** Open the ink overlay on a leaf. */
  ink(leaf: LeafView, title: string): void;
  /** Close the ink overlay, back on that leaf. */
  inked(leaf: LeafView): void;
  say(notice?: string): void;
  busy(): boolean;
};

const sameLeaf = (a: ReadView | undefined, target: string, slug?: string) =>
  a?.kind === "leaf" && a.leaf.target === target && a.leaf.slug === slug;

/**
 * The terminal's Inspect: read a leaf or a Dossier, Seek the Dossiers, ink a
 * writable leaf (stale-aware, like the web book), and enter, archive or
 * restore Dossiers. Writes are Idle only; reading is not.
 */
export function createInspect(host: InspectHost) {
  const { handlers } = host;

  async function read(target: string, slug?: string) {
    if (!handlers.inspect) throw new Error("Inspect is not available here.");
    return handlers.inspect(target, slug);
  }

  async function openLeaf(target: string, slug?: string): Promise<void> {
    const shown = host.current();
    // a veiled Twists leaf opened again is the choice to read ahead
    if (target === "twists" && shown?.kind === "leaf" && shown.leaf.target === "twists") {
      host.show({ kind: "leaf", leaf: { ...shown.leaf, veiled: false } });
      return;
    }
    let leaf;
    try {
      leaf = await read(target, slug);
    } catch {
      host.say(slug ? `No dossier is entered as ${slug}.` : "Could not read that leaf.");
      return;
    }
    host.show({
      kind: "leaf",
      leaf: { target, ...(slug ? { slug } : {}), leaf, ...(target === "twists" ? { veiled: true } : {}) },
    });
  }

  async function openDossiers(query: string, archives: boolean): Promise<void> {
    try {
      const leaf = await read("dossiers");
      host.show({ kind: "dossiers", index: { leaf, query, archives } });
    } catch {
      host.say("Could not read the dossiers.");
    }
  }

  /** Read the open leaf or index again (after a Turn, a Rewind, a write). */
  async function reload(): Promise<void> {
    const view = host.current();
    if (view?.kind === "leaf") {
      const { target, slug } = view.leaf;
      const leaf = await read(target, slug).catch(() => null);
      const now = host.current();
      if (!leaf || !sameLeaf(now, target, slug) || now?.kind !== "leaf") return;
      // a note about the last save holds while the disk still says the same
      const same = leaf.hash === now.leaf.leaf.hash;
      host.refresh({
        kind: "leaf",
        leaf: same ? { ...now.leaf, leaf } : { ...now.leaf, leaf, stale: false, error: undefined },
      });
    } else if (view?.kind === "dossiers") {
      const leaf = await read("dossiers").catch(() => null);
      const now = host.current();
      if (!leaf || now?.kind !== "dossiers") return;
      host.refresh({ kind: "dossiers", index: { ...now.index, leaf } });
    }
  }

  function ink(): void {
    const view = host.current();
    if (view?.kind !== "leaf" || !leafWritable(view.leaf)) {
      host.say("Open a leaf to write first: /sheet, /world, /seed, /beats, /quests, /twists, or /dossier <slug>.");
      return;
    }
    if (host.busy()) {
      host.say(BUSY);
      return;
    }
    const title = LEAF_TITLE[view.leaf.target]?.title ?? view.leaf.target;
    host.ink(
      { ...view.leaf, veiled: false },
      view.leaf.slug ? `Ink · ${view.leaf.slug}` : `Ink · ${title}`,
    );
  }

  async function saveInk(view: LeafView, text: string): Promise<void> {
    if (text === view.leaf.text) {
      host.inked(view);
      return;
    }
    if (!handlers.saveInspect) return;
    const { target, slug } = view;
    try {
      await handlers.saveInspect(target, text, view.leaf.hash, slug);
    } catch (err) {
      if (isCampaignError(err) && err.code === "stale") {
        // someone else wrote this leaf: show theirs, not the draft
        host.inked({
          ...view,
          leaf: { ...view.leaf, text: err.diskText ?? "", hash: err.diskHash ?? view.leaf.hash },
          stale: true,
          error: undefined,
        });
        return;
      }
      host.say(refusal("save", err));
      return;
    }
    const leaf = await read(target, slug).catch(() => ({ ...view.leaf, text }));
    host.inked({ ...view, leaf, stale: false, error: undefined });
  }

  async function create(name: string): Promise<void> {
    const slug = toSlug(name);
    if (!slug) {
      host.say("Invalid slug.");
      return;
    }
    try {
      await handlers.createDossier?.(slug);
    } catch (err) {
      host.say(refusal("create", err));
      return;
    }
    await openLeaf("dossiers", slug);
  }

  async function archive(slug: string | undefined, archived: boolean): Promise<void> {
    const view = host.current();
    const target =
      slug ?? (view?.kind === "leaf" && view.leaf.target === "dossiers" ? view.leaf.slug : undefined);
    if (!target) {
      host.say(`Name a dossier: ${archived ? "/archive" : "/restore"} <slug>`);
      return;
    }
    try {
      await handlers.archiveDossier?.(target, archived);
    } catch (err) {
      host.say(refusal("save", err));
      return;
    }
    await reload();
    host.say(`${archived ? "Archived" : "Restored"} ${target}.`);
  }

  return { openLeaf, openDossiers, reload, ink, saveInk, create, archive };
}

export type Inspect = ReturnType<typeof createInspect>;
