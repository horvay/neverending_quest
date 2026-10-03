/**
 * The Almanac in the terminal: the player's entries and the book's, one
 * entry's page (what it recognises, what it is built on, its values, which
 * installed models it catches), and the form that writes or edits one of the
 * player's own. Writes go through the surface, which refuses what it cannot
 * keep.
 */
import {
  GENERAL_ENTRY_ID,
  entryChain,
  findEntry,
  knownArchitectures,
  recognizeModel,
  type AlmanacEntry,
} from "@nq/local-inference/almanac.ts";
import type { LocalTuningField } from "@nq/local-inference/tuning.ts";
import type { HomeAlmanac } from "../../../home/index.ts";
import {
  SAMPLER_FIELDS,
  catches,
  draftFrom,
  entryFromDraft,
  entryOwnValues,
  familyOptions,
  formatKnob,
  summarizeTuning,
  whenClause,
  type Catch,
  type EntryDraft,
} from "../../../home/almanac_pages.ts";
import { partialNumber } from "../../../home/fields.ts";
import { type Choice, type Field, FormScreen, NOT_A_NUMBER } from "./form.ts";
import { type HomeCtx, type HomeScreen, playerMessage, type Row, type View } from "./screen.ts";

/** The Almanac as Home last read it, shared by the pages open on it. */
export class AlmanacState {
  data: HomeAlmanac | null = null;

  constructor(private readonly ctx: HomeCtx) {}

  async load(): Promise<void> {
    try {
      this.data = await this.ctx.surface.almanac();
    } catch {
      this.ctx.notice("Could not read the Almanac.");
    }
    this.ctx.repaint();
  }

  get all(): AlmanacEntry[] {
    return this.data?.entries ?? [];
  }

  get models(): HomeAlmanac["models"] {
    return this.data?.models ?? [];
  }
}

const QUILL = "✎ ";
const COLUMNS = [
  ["values", "Always"],
  ["thinking", "While thinking"],
  ["plain", "Without thinking"],
] as const;

function catchRows(caught: Catch[], none: string): Row[] {
  if (caught.length === 0) return [{ name: none, description: "", value: "info:none" }];
  return caught.map((item) => ({
    name: `${item.caught ? "✓" : "✗"} ${item.model.name}`,
    description: item.caught ? "" : `${item.winner.title} comes first`,
    value: `info:${item.model.selector ?? item.model.name}`,
  }));
}

export class AlmanacIndexScreen implements HomeScreen {
  private query = "";
  private readonly state: AlmanacState;

  constructor(
    private readonly ctx: HomeCtx,
    state?: AlmanacState,
  ) {
    this.state = state ?? new AlmanacState(ctx);
    if (!state) void this.state.load();
  }

  view(): View {
    const heading = "The Almanac";
    const lead =
      "Recommended settings for each family of model. Auto reads your entries first, then the book's.";
    const input = { value: this.query, placeholder: "Find an entry: Gemma, Qwen 3.8, Mistral…", filter: true };
    const hint = "Type to find · ↑↓ move · Enter open · Esc back";
    if (!this.state.data) {
      return { heading, status: `${lead}\nOpening the Almanac…`, rows: [], input, hint };
    }
    const { all, models } = this.state;
    const needle = this.query.trim().toLowerCase();
    const visible = (entry: AlmanacEntry) =>
      !needle ||
      entry.title.toLowerCase().includes(needle) ||
      (entry.maker ?? "").toLowerCase().includes(needle);
    const caughtBy = new Map<string, number>();
    for (const model of models) {
      const id = recognizeModel(model.identity, all).entry.id;
      caughtBy.set(id, (caughtBy.get(id) ?? 0) + 1);
    }
    const row = (entry: AlmanacEntry, group: string): Row => {
      const parent = entry.extends ? findEntry(entry.extends, all) : undefined;
      const own = entryOwnValues(entry);
      const summary = Object.keys(own).length > 0 ? summarizeTuning(own, 3) : "";
      const count = caughtBy.get(entry.id) ?? 0;
      return {
        name: `${entry.source === "yours" ? QUILL : ""}${entry.title}`,
        description: [
          group,
          summary || (parent ? `built on ${parent.title}` : ""),
          count === 0 ? "" : count === 1 ? "1 of yours" : `${count} of yours`,
        ]
          .filter(Boolean)
          .join(" · "),
        value: `entry:${entry.id}`,
      };
    };
    const yours = all.filter((entry) => entry.source === "yours");
    const { makers, book } = familyOptions(all);
    const general = all.find((entry) => entry.id === GENERAL_ENTRY_ID);
    const rows: Row[] = [
      { name: `${QUILL}Write a new entry`, description: "", value: "write" },
      ...yours.filter(visible).map((entry) => row(entry, "In your hand")),
      ...makers.flatMap((maker) =>
        book
          .filter((entry) => (entry.maker ?? "Other") === maker && visible(entry))
          .map((entry) => row(entry, maker)),
      ),
      ...(general && visible(general) ? [row(general, "For everything else")] : []),
      { name: "Back", value: "back" },
    ];
    return {
      heading,
      status: yours.length === 0 ? `${lead}\nIn your hand: nothing written here yet.` : lead,
      rows,
      input,
      hint,
    };
  }

  filter(text: string): void {
    this.query = text;
  }

  choose(value: string): void {
    if (value === "write") {
      this.ctx.push(new AlmanacEditScreen(this.ctx, this.state, draftFrom(undefined), true));
    } else if (value.startsWith("entry:")) {
      this.ctx.push(
        new AlmanacEntryScreen(this.ctx, this.state, value.slice("entry:".length), true),
      );
    }
  }
}

export class AlmanacEntryScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly state: AlmanacState,
    private readonly id: string,
    /** Opened from the Almanac's index, rather than from the load page. */
    private readonly fromIndex: boolean,
  ) {
    if (!state.data) void state.load();
  }

  /** Back past every entry page to where the Almanac was opened. */
  back(): void {
    this.ctx.popWhile((screen) => screen instanceof AlmanacEntryScreen);
  }

  private entry(): AlmanacEntry | undefined {
    return findEntry(this.id, this.state.all);
  }

  view(): View {
    if (!this.state.data) {
      return { heading: "The Almanac", status: "Opening the Almanac…", rows: [] };
    }
    const entry = this.entry();
    const back: Row = {
      name: this.fromIndex ? "‹ All entries" : "‹ This computer",
      value: "back",
    };
    if (!entry) {
      return {
        heading: "The Almanac",
        status: "That entry is no longer in the Almanac.",
        rows: [back],
      };
    }
    const { all, models } = this.state;
    const chain = entryChain(entry, all).slice(1);
    const mine = entry.source === "yours";
    const status = [
      mine ? `${QUILL}In your hand` : (entry.maker ?? "By the book"),
      whenClause(entry),
      ...(chain.length > 0
        ? [
            `Built on ${chain.map((link) => link.title).join(", then ")}: anything this page leaves blank comes from there.`,
          ]
        : []),
      ...(entry.notes ?? []).map((note) => `· ${note}`),
    ];
    const rows: Row[] = mine
      ? [
          { name: "Edit this entry", value: "edit" },
          { name: "Tear out…", value: "tear" },
        ]
      : [{ name: `${QUILL}Copy into your hand`, value: "copy" }];
    for (const link of chain) {
      rows.push({ name: `Built on ${link.title} ›`, value: `entry:${link.id}` });
    }
    const columns = COLUMNS.filter(([key]) => entry[key] && Object.keys(entry[key]!).length > 0);
    for (const field of SAMPLER_FIELDS) {
      const cells = columns
        .filter(([key]) => entry[key]?.[field.key] !== undefined)
        .map(([key, label]) => `${label} ${formatKnob(field, entry[key]![field.key]!)}`);
      if (cells.length > 0) {
        rows.push({ name: field.label, description: cells.join(" · "), value: `info:${field.key}` });
      }
    }
    rows.push(
      { name: "Catches your models:", value: "info:catches" },
      ...catchRows(catches(entry, models, all), "None of your installed models."),
      back,
    );
    return { heading: entry.title, status: status.join("\n"), rows };
  }

  choose(value: string): void {
    const entry = this.entry();
    if (!entry) return;
    const { ctx, state, fromIndex } = this;
    if (value === "edit") {
      ctx.push(new AlmanacEditScreen(ctx, state, draftFrom(entry), fromIndex, entry.id));
    } else if (value === "copy") {
      ctx.push(new AlmanacEditScreen(ctx, state, draftFrom(entry, true), fromIndex));
    } else if (value === "tear") {
      ctx.push(new TearOutScreen(ctx, state, entry));
    } else if (value.startsWith("entry:")) {
      ctx.push(new AlmanacEntryScreen(ctx, state, value.slice("entry:".length), fromIndex));
    }
  }
}

class TearOutScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly state: AlmanacState,
    private readonly entry: AlmanacEntry,
  ) {}

  view(): View {
    return {
      heading: this.entry.title,
      status: "Tear this page out of the Almanac?",
      rows: [
        { name: "Keep it", value: "back" },
        { name: "Tear it out", value: "tear" },
      ],
    };
  }

  async choose(value: string): Promise<void> {
    if (value !== "tear") return;
    try {
      await this.ctx.surface.deleteAlmanacEntry(this.entry.id);
    } catch (error) {
      this.ctx.notice(playerMessage(error, "Could not tear out that entry."));
      return;
    }
    await this.state.load();
    // the page is gone: back past it to where the Almanac was opened
    this.ctx.popWhile(
      (screen) => screen instanceof TearOutScreen || screen instanceof AlmanacEntryScreen,
    );
  }
}

/** Writes a new entry into the player's hand, or edits one already there. */
export class AlmanacEditScreen extends FormScreen {
  constructor(
    ctx: HomeCtx,
    state: AlmanacState,
    draft: EntryDraft,
    fromIndex: boolean,
    editing?: string,
  ) {
    const architectures = () =>
      [
        ...new Set([
          ...knownArchitectures(),
          ...state.models.flatMap((model) =>
            model.identity.architecture ? [model.identity.architecture] : [],
          ),
        ]),
      ].sort();
    const builtOn = (): Choice[] => {
      const { yours, makers, book } = familyOptions(state.all);
      return [
        { name: "Nothing (blank values follow the model)", value: "" },
        ...yours
          .filter((entry) => entry.id !== editing)
          .map((entry) => ({ name: entry.title, value: entry.id, description: "Your entries" })),
        ...makers.flatMap((maker) =>
          book
            .filter((entry) => (entry.maker ?? "Other") === maker)
            .map((entry) => ({ name: entry.title, value: entry.id, description: maker })),
        ),
        { name: "General settings", value: GENERAL_ENTRY_ID },
      ];
    };
    const save = async () => {
      const { source: _source, id: _id, ...entry } = entryFromDraft(
        draft,
        editing ?? "draft-preview",
      );
      let saved: AlmanacEntry;
      try {
        saved = await ctx.surface.saveAlmanacEntry({
          ...entry,
          ...(editing ? { id: editing } : {}),
        });
      } catch (error) {
        ctx.notice(playerMessage(error, "Could not write to the Almanac."));
        return;
      }
      await state.load();
      ctx.pop();
      if (!editing) ctx.push(new AlmanacEntryScreen(ctx, state, saved.id, fromIndex));
    };
    super(ctx, {
      heading: editing ? `${QUILL}Editing your entry` : `${QUILL}A new entry`,
      status: () => "Leave a value blank to take it from what the entry is built on.",
      fields: (): Field[] => {
        const preview = entryFromDraft(draft, editing ?? "draft-preview");
        const others = state.all.filter((entry) => entry.id !== editing);
        return [
          {
            kind: "text",
            key: "title",
            label: "Title",
            text: draft.title,
            placeholder: "Lucent Witch, Bonsai at 0.6…",
            set: (text) => {
              draft.title = text;
            },
          },
          {
            kind: "text",
            key: "names",
            label: "Names like",
            text: draft.names,
            placeholder: "*lucent-witch*, *witch-31b*",
            help: "Separate patterns with commas. * stands for anything; case, spaces, _ and - don't matter. The file name, the model's own name and its base models are all tried.",
            set: (text) => {
              draft.names = text;
            },
          },
          {
            kind: "choice",
            key: "architecture",
            label: "Architecture",
            value: draft.architecture,
            choices: [
              { name: "Any", value: "" },
              ...architectures().map((arch) => ({ name: arch, value: arch })),
            ],
            set: (arch) => {
              draft.architecture = arch;
            },
          },
          {
            kind: "choice",
            key: "extends",
            label: "Built on",
            value: draft.extends,
            choices: builtOn(),
            set: (id) => {
              draft.extends = id;
            },
          },
          ...SAMPLER_FIELDS.map(
            (field): Field => ({
              kind: "action",
              key: `knob:${field.key}`,
              label: `${field.label}: ${COLUMNS.map(([column]) => draft[column][field.key]?.trim() || "—").join(" / ")}`,
              help: "Always / while thinking / without thinking",
              run: () => ctx.push(knobScreen(ctx, draft, field)),
            }),
          ),
          {
            kind: "action",
            key: "notes",
            label: `Notes: ${draft.notes.split("\n").filter((note) => note.trim()).length}`,
            help: "Shown on the load page when this entry is used.",
            run: () => ctx.push(notesScreen(ctx, draft)),
          },
          { kind: "note", key: "would-catch", label: "Would catch:" },
          ...catchRows(
            catches(preview, state.models, [preview, ...others]),
            "None of your installed models yet.",
          ).map((row): Field => ({ kind: "note", key: row.value, label: row.name, help: row.description ?? "" })),
          { kind: "action", key: "save", label: "Write it down", run: save },
          { kind: "action", key: "cancel", label: "Cancel", run: () => ctx.pop() },
        ];
      },
    });
  }
}

/** One sampler's three values: always, while thinking, without thinking. */
function knobScreen(ctx: HomeCtx, draft: EntryDraft, field: LocalTuningField): HomeScreen {
  return new FormScreen(ctx, {
    heading: field.label,
    status: () => `${field.help}\nLeave a value blank to take it from what the entry is built on.`,
    fields: () => [
      ...COLUMNS.map(
        ([column, label]): Field => ({
          kind: "text",
          key: column,
          label,
          text: draft[column][field.key] ?? "",
          set: (text) => {
            const value = text.trim();
            if (value && partialNumber(value) === undefined) return NOT_A_NUMBER;
            const next = { ...draft[column] };
            if (value) next[field.key] = value;
            else delete next[field.key];
            draft[column] = next;
          },
        }),
      ),
      { kind: "action", key: "done", label: "Done", run: () => ctx.pop() },
    ],
  });
}

/** The entry's notes, one per row; a blank note is removed. */
function notesScreen(ctx: HomeCtx, draft: EntryDraft): HomeScreen {
  const notes = () => draft.notes.split("\n").filter((note) => note.trim());
  return new FormScreen(ctx, {
    heading: "Notes",
    status: () => "Shown on the load page when this entry is used.",
    fields: () => [
      ...notes().map(
        (note, index): Field => ({
          kind: "text",
          key: `note:${index}`,
          label: `Note ${index + 1}`,
          text: note,
          set: (text) => {
            const next = notes();
            next[index] = text.trim();
            draft.notes = next.filter(Boolean).join("\n");
          },
        }),
      ),
      {
        kind: "text",
        key: "add",
        label: "Add a note",
        text: "",
        set: (text) => {
          if (text.trim()) draft.notes = [...notes(), text.trim()].join("\n");
        },
      },
      { kind: "action", key: "done", label: "Done", run: () => ctx.pop() },
    ],
  });
}

