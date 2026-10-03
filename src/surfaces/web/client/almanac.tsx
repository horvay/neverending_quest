import { useState } from "preact/hooks";
import { findEntry } from "@nq/local-inference/almanac.ts";
import type { AlmanacApi } from "./almanac/data.ts";
import { type EntryDraft, draftFrom } from "../../../home/almanac_pages.ts";
import {
  AlmanacEditor,
  AlmanacEntryPage,
  AlmanacIndex,
} from "./almanac/pages.tsx";

type AlmanacPage =
  | { kind: "index" }
  | { kind: "entry"; id: string }
  | { kind: "edit"; draft: EntryDraft; editing?: string };

type AlmanacBookProps = {
  almanac: AlmanacApi;
  /** Opens on this entry's page. */
  startAt?: string;
  onClose: () => void;
  closeLabel: string;
};

/** The Almanac: an appendix of temperaments, the player's first. */
export function AlmanacBook(props: AlmanacBookProps) {
  const { almanac } = props;
  const entries = almanac.data?.entries ?? [];
  const models = almanac.data?.models ?? [];
  const [page, setPage] = useState<AlmanacPage>(
    props.startAt ? { kind: "entry", id: props.startAt } : { kind: "index" },
  );
  const [query, setQuery] = useState("");

  return (
    <div class="almanac">
      <div class="home-settings-head almanac-head">
        <div>
          <h2 id="almanac-title">The Almanac</h2>
          <p>
            Recommended settings for each family of model. Auto reads your
            entries first, then the book's.
          </p>
        </div>
        <button
          type="button"
          class="home-settings-close"
          data-modal-first
          onClick={props.onClose}
        >
          {props.closeLabel}
        </button>
      </div>
      <div class="almanac-body">
        {almanac.data === null && !almanac.error ? (
          <p class="almanac-empty">Opening the Almanac…</p>
        ) : page.kind === "index" ? (
          <AlmanacIndex
            entries={entries}
            models={models}
            yours={almanac.yours}
            all={almanac.all}
            query={query}
            onQuery={setQuery}
            onOpen={(id) => setPage({ kind: "entry", id })}
            onWrite={() => setPage({ kind: "edit", draft: draftFrom(undefined) })}
          />
        ) : page.kind === "entry" ? (
          <AlmanacEntryPage
            entry={findEntry(page.id, almanac.all)}
            models={models}
            almanac={almanac}
            onBack={() => setPage({ kind: "index" })}
            onOpen={(id) => setPage({ kind: "entry", id })}
            onEdit={(entry, copy) =>
              setPage({
                kind: "edit",
                draft: draftFrom(entry, copy),
                ...(copy ? {} : { editing: entry.id }),
              })
            }
          />
        ) : (
          <AlmanacEditor
            draft={page.draft}
            editing={page.editing}
            models={models}
            almanac={almanac}
            onDraft={(draft) => setPage({ ...page, draft })}
            onCancel={() =>
              setPage(page.editing ? { kind: "entry", id: page.editing } : { kind: "index" })
            }
            onSaved={(id) => setPage({ kind: "entry", id })}
          />
        )}
      </div>
    </div>
  );
}
