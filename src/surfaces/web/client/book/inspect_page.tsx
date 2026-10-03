import { useEffect, useState } from "preact/hooks";
import type { ContextUsage } from "../../../../play/leaf.ts";
import { parseDossierFrontmatter } from "../../../../campaign/frontmatter.ts";
import { Fleuron, QuillIcon } from "../ornament.tsx";
import {
  BLANK_REASON,
  LEAF_TITLE,
  TABS,
  TAB_LABEL,
  WORLD_LEAVES,
  inspectHasInk,
  inspectManuscript,
  inspectWritable,
} from "../../../shared/leaves.ts";
import { Manuscript, SourceLines } from "./manuscript.tsx";
import { MarkIcon } from "./marks.tsx";
import {
  dossierExcerpt,
  filterBeatsText,
  rankDossierHits,
} from "../../../shared/seek.ts";
import { DossierIndexRow, LeafSearch } from "./seek.tsx";
import { SettingsLeaf } from "./settings_leaf.tsx";
import { rollHistory } from "../../../../play/roll_log.ts";
import { StatusLeaf } from "./status_leaf.tsx";
import { toSlug } from "../../../shared/text.ts";
import type { BookAppProps } from "./types.ts";

type InspectPageProps = Pick<
  BookAppProps,
  | "inspect"
  | "history"
  | "scratch"
  | "playSettings"
  | "fixedSettings"
  | "onInspect"
  | "onSaveInspect"
  | "onCreateDossier"
  | "onArchiveDossier"
  | "onHygiene"
  | "onLuck"
  | "onSavePlaySettings"
> & {
  /** Compose, Inspect and the brush are locked while anything is in flight. */
  locked: boolean;
  usage: ContextUsage | undefined;
  /** Close the leaf on a narrow screen, where it slides over the story. */
  onCloseRail: () => void;
  /** Continue from a Turn asks first; the story page shows that question. */
  onConfirmContinue: (turn: number) => void;
};

/**
 * The other leaf: Inspect of Campaign memory (sheet, world, Dossiers, beats,
 * quests, twists, seed), Status with its Roll Log, and Settings. Holds its
 * own inking draft and Seek; the story page owns everything else.
 */
export function InspectPage(props: InspectPageProps) {
  const {
    inspect,
    history = [],
    scratch = [],
    playSettings,
    fixedSettings,
    onInspect,
    onSaveInspect,
    onCreateDossier,
    onArchiveDossier,
    onHygiene,
    onLuck,
    onSavePlaySettings,
    locked,
    usage,
    onCloseRail,
    onConfirmContinue,
  } = props;
  const [draft, setDraft] = useState(inspect.text);
  const [newSlug, setNewSlug] = useState("");
  const [leafQuery, setLeafQuery] = useState("");
  const [inking, setInking] = useState(false);
  const [spoiled, setSpoiled] = useState(false);
  useEffect(() => {
    setDraft(inspect.text);
    setInking(false);
  }, [inspect.text, inspect.target, inspect.slug, inspect.hash]);
  useEffect(() => {
    setLeafQuery("");
    setSpoiled(false);
  }, [inspect.target]);
  const dossierHits = rankDossierHits(inspect.entries ?? [], leafQuery);
  // an open dossier is titled by its own name, not the section's
  const dossierTitle =
    inspect.target === "dossiers" && inspect.slug
      ? (parseDossierFrontmatter(inspect.text).name?.trim() ||
          inspect.entries?.find((e) => e.slug === inspect.slug)?.name ||
          null)
      : null;
  const liveDossierHits = dossierHits.filter((e) => !e.archived);
  const filedDossierHits = dossierHits.filter((e) => e.archived);
  const beatsShown =
    inspect.target === "beats" ? filterBeatsText(draft, leafQuery) : draft;
  const leaveInk = () => {
    setDraft(inspect.text);
    setInking(false);
  };

  return (
    <aside class="page recto inspect">
      <header class="page-head recto-head">
        <button
          type="button"
          class="inspect-close"
          onClick={() => onCloseRail()}
        >
          Back to the story
        </button>
      </header>
      <div class="inspect-body">
        <div class="leaf-turn" key={`${inspect.target}:${inspect.slug ?? ""}`}>
        {LEAF_TITLE[inspect.target] ? (
          <header class="leaf-head">
            <p class="leaf-head-kicker">
              {inspect.target === "dossiers" && inspect.slug
                ? inspect.archived
                  ? "Dossier · archived"
                  : "Dossier"
                : LEAF_TITLE[inspect.target]!.kicker}
            </p>
            <h2 class="leaf-head-title">
              {dossierTitle ?? LEAF_TITLE[inspect.target]!.title}
            </h2>
            <Fleuron class="leaf-head-fleuron" />
          </header>
        ) : null}
        {inspect.target === "dossiers" &&
        inspect.entries &&
        !inspect.slug ? (
          <>
            {inspect.entries.length > 0 ? (
              <LeafSearch
                id="inspect-find-dossier"
                value={leafQuery}
                hint="a name, or a phrase from the leaf"
                onInput={setLeafQuery}
              />
            ) : null}
            {inspect.entries.length > 0 ? (
              dossierHits.length > 0 ? (
              <>
              {liveDossierHits.length > 0 ? (
              <ul class="dossiers">
                {liveDossierHits.map((e) => (
                  <DossierIndexRow
                    key={e.slug}
                    name={e.name ?? e.slug}
                    excerpt={
                      e.via === "body"
                        ? dossierExcerpt(e, leafQuery)
                        : ""
                    }
                    archived={false}
                    locked={locked}
                    onOpen={() => onInspect("dossiers", e.slug)}
                    onFile={
                      onArchiveDossier
                        ? () => void onArchiveDossier(e.slug, true)
                        : undefined
                    }
                  />
                ))}
              </ul>
              ) : null}
              {filedDossierHits.length > 0 ? (
                <details
                  class="filed-leaves"
                  {...(leafQuery.trim()
                    ? { open: filedDossierHits.length > 0 }
                    : {})}
                >
                  <summary>Archives</summary>
                  <ul class="dossiers">
                    {filedDossierHits.map((e) => (
                      <DossierIndexRow
                        key={e.slug}
                        name={e.name ?? e.slug}
                        excerpt={
                          e.via === "body"
                            ? dossierExcerpt(e, leafQuery)
                            : ""
                        }
                        archived
                        locked={locked}
                        onOpen={() => onInspect("dossiers", e.slug)}
                        onFile={
                          onArchiveDossier
                            ? () => void onArchiveDossier(e.slug, false)
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                </details>
              ) : null}
              </>
              ) : (
                <p class="blank-reason">Nothing on these leaves matches.</p>
              )
            ) : (
              <p class="blank-reason">
                No names are entered yet. People will appear here as they
                are met — or write one now.
              </p>
            )}
            {inspect.error ? (
              <p class="inspect-stale">{inspect.error}</p>
            ) : null}
            <form
              class="inspect-create"
              onSubmit={(e) => {
                e.preventDefault();
                const slug = toSlug(newSlug);
                if (locked || !slug || !onCreateDossier) {
                  return;
                }
                void Promise.resolve(onCreateDossier(slug)).then(() => {
                  setNewSlug("");
                });
              }}
            >
              <label class="sr-only" for="inspect-new-slug">
                A name to enter
              </label>
              <input
                id="inspect-new-slug"
                type="text"
                value={newSlug}
                disabled={locked}
                placeholder="A name to enter"
                onInput={(e) =>
                  setNewSlug((e.target as HTMLInputElement).value)
                }
              />
              <button
                type="submit"
                disabled={locked || !toSlug(newSlug)}
              >
                Enter
              </button>
            </form>
          </>
        ) : inspectWritable(inspect) ? (
          <>
            {inspect.target === "dossiers" && inspect.slug ? (
              <nav
                class="dossier-toolbar"
                aria-label="Dossier navigation"
              >
                <button
                  type="button"
                  class="dossier-back"
                  onClick={() => onInspect("dossiers")}
                >
                  Back to dossiers
                </button>
                {onArchiveDossier ? (
                  <button
                    type="button"
                    class="file-leaf"
                    disabled={locked}
                    onClick={() =>
                      void onArchiveDossier(
                        inspect.slug!,
                        !inspect.archived,
                      )
                    }
                  >
                    {inspect.archived
                      ? "Restore this leaf"
                      : "Archive"}
                  </button>
                ) : null}
              </nav>
            ) : null}
            {inspect.target === "world" || inspect.target === "seed" ? (
              <nav class="world-leaves" aria-label="World leaves">
                {WORLD_LEAVES.map((leaf) => (
                  <button
                    key={leaf.target}
                    type="button"
                    class={inspect.target === leaf.target ? "on" : ""}
                    aria-current={
                      inspect.target === leaf.target ? "page" : undefined
                    }
                    onClick={() => onInspect(leaf.target)}
                  >
                    {leaf.label}
                  </button>
                ))}
              </nav>
            ) : null}
          {inspect.target === "twists" &&
          inspectHasInk(draft) &&
          !spoiled ? (
            <div class="manuscript-leaf spoiler-leaf">
              <p class="leaf-kicker">Turns the book has not taken yet.</p>
              <p class="blank-reason">
                The Game Master keeps what it might spring on you here.
                Reading it is reading ahead.
              </p>
              <button
                type="button"
                class="spoiler-veil"
                onClick={() => setSpoiled(true)}
              >
                <pre class="raw" aria-hidden="true">
                  {draft}
                </pre>
                <span class="spoiler-cue">
                  <span class="spoiler-seal" aria-hidden="true" />
                  <span class="spoiler-cue-text">Read ahead anyway</span>
                </span>
              </button>
            </div>
          ) : !inspectHasInk(draft) && !inking ? (
            <div class="blank-leaf">
              {inspect.stale ? (
                <p class="inspect-stale">Changed on disk — showing disk text.</p>
              ) : inspect.error ? (
                <p class="inspect-stale">{inspect.error}</p>
              ) : null}
              <img
                class="blank-vignette"
                src="/ink/vignette.webp"
                alt=""
                aria-hidden="true"
              />
              <p class="leaf-kicker">This leaf is still clean.</p>
              <p class="blank-reason">
                {BLANK_REASON[inspect.target] ??
                  "Nothing is written on this leaf yet."}
              </p>
              <button
                type="button"
                class="ink-start"
                disabled={locked}
                onClick={() => setInking(true)}
              >
                <QuillIcon class="ink-start-quill" />
                Ink the first line
              </button>
            </div>
          ) : !inking ? (
            <div class="manuscript-leaf">
              {inspect.stale ? (
                <p class="inspect-stale">Changed on disk — showing disk text.</p>
              ) : inspect.error ? (
                <p class="inspect-stale">{inspect.error}</p>
              ) : null}
              {inspect.target === "beats" ? (
                <LeafSearch
                  id="inspect-find-beat"
                  value={leafQuery}
                  hint="a phrase from the beats"
                  onInput={setLeafQuery}
                />
              ) : null}
              {inspect.target === "beats" &&
              leafQuery.trim() &&
              !beatsShown.trim() ? (
                <p class="blank-reason">No beats match.</p>
              ) : (
              <button
                type="button"
                class="ms-ink"
                aria-label="Ink this leaf"
                disabled={locked}
                onClick={() => setInking(true)}
              >
                {inspectManuscript(inspect) ? (
                  <Manuscript
                    text={draft}
                    omitTitle={dossierTitle ?? undefined}
                  />
                ) : (
                  <SourceLines
                    text={inspect.target === "beats" ? beatsShown : draft}
                  />
                )}
              </button>
              )}
            </div>
          ) : (
          <form
            class="inspect-edit"
            onSubmit={(e) => {
              e.preventDefault();
              if (locked || !onSaveInspect) return;
              void onSaveInspect(draft);
            }}
          >
            {inspect.stale ? (
              <p class="inspect-stale">Changed on disk — showing disk text.</p>
            ) : inspect.error ? (
              <p class="inspect-stale">{inspect.error}</p>
            ) : null}
            <label class="sr-only" for="inspect-body">
              inspect body
            </label>
            <textarea
              id="inspect-body"
              class="raw"
              value={draft}
              disabled={locked}
              onInput={(e) =>
                setDraft((e.target as HTMLTextAreaElement).value)
              }
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                leaveInk();
              }}
            />
            <p class="leaf-wet">
              <button type="button" onClick={leaveInk}>
                Leave it
              </button>
              {draft !== inspect.text ? (
                <>
                  <button type="submit" disabled={locked}>
                    Set this leaf
                  </button>
                  <span>The ink is still wet.</span>
                </>
              ) : null}
            </p>
          </form>
          )}
          </>
        ) : inspect.target === "settings" ? (
          <SettingsLeaf
            settings={playSettings}
            fixed={fixedSettings}
            locked={locked}
            onSave={onSavePlaySettings}
          />
        ) : inspect.target === "status" ? (
          <StatusLeaf
            raw={inspect.text}
            locked={locked}
            history={history}
            context={usage}
            rolls={rollHistory(scratch)}
            onHygiene={onHygiene}
            onContinue={(turn) => onConfirmContinue(turn)}
            onLuck={onLuck}
          />
        ) : (
          <pre class="raw">
            {inspect.text.trim() || "Nothing written yet."}
          </pre>
        )}
        </div>
      </div>
      <nav class="tabs" aria-label="Leaves">
        {TABS.map((id) => {
          const on =
            inspect.target === id ||
            (id === "world" && inspect.target === "seed");
          return (
          <button
            key={id}
            type="button"
            class={`mark mark-${id}${on ? " on" : ""}`}
            aria-current={on ? "page" : undefined}
            onClick={() => onInspect(id)}
          >
            <MarkIcon id={id} />
            <span>{TAB_LABEL[id]}</span>
          </button>
          );
        })}
      </nav>
    </aside>
  );
}
