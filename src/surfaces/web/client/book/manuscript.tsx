import type { ComponentChildren } from "preact";
import {
  parseDossierFrontmatter,
  splitDossierDocument,
} from "../../../../campaign/frontmatter.ts";
import { titleCase } from "./text.ts";

function renderInline(text: string): ComponentChildren {
  const parts: ComponentChildren[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={`b${i++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Dossier frontmatter as a small record instead of raw YAML. */
function ManuscriptRecord(props: { text: string; hasHeading: boolean }) {
  const fm = parseDossierFrontmatter(props.text);
  const known =
    fm.kind !== undefined ||
    fm.regard !== undefined ||
    fm.aliases !== undefined ||
    Boolean(fm.personality) ||
    Boolean(fm.appearance);
  if (!known) return null;
  const aliases = fm.aliases ?? [];
  return (
    <dl class="ms-record">
      {fm.name && !props.hasHeading ? (
        <div class="ms-record-row is-wide">
          <dt>Name</dt>
          <dd>{fm.name}</dd>
        </div>
      ) : null}
      {fm.kind ? (
        <div class="ms-record-row">
          <dt>Kind</dt>
          <dd>{titleCase(fm.kind)}</dd>
        </div>
      ) : null}
      {fm.regard !== undefined ? (
        <div class="ms-record-row">
          <dt>Regard</dt>
          <dd class="ms-regard">
            <span
              class="ms-regard-pips"
              role="img"
              aria-label={`Regard ${fm.regard} of 10`}
            >
              {Array.from({ length: 10 }, (_, i) => (
                <i key={i} class={i < fm.regard! ? "is-on" : ""} />
              ))}
            </span>
            <span class="ms-regard-num" aria-hidden="true">
              {fm.regard} / 10
            </span>
          </dd>
        </div>
      ) : null}
      <div class="ms-record-row is-wide">
        <dt>Also known as</dt>
        <dd class={aliases.length === 0 ? "is-empty" : ""}>
          {aliases.length > 0 ? aliases.join(", ") : "No other names"}
        </dd>
      </div>
      {fm.appearance ? (
        <div class="ms-record-row is-wide">
          <dt>Appearance</dt>
          <dd>{fm.appearance}</dd>
        </div>
      ) : null}
      {fm.personality ? (
        <div class="ms-record-row is-wide">
          <dt>Personality</dt>
          <dd>{fm.personality}</dd>
        </div>
      ) : null}
      {fm.stub_of ? (
        <div class="ms-record-row is-wide">
          <dt>Merged into</dt>
          <dd>{fm.stub_of}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function Manuscript(props: { text: string; omitTitle?: string }) {
  const split = splitDossierDocument(props.text);
  const body = split.body;
  type Block = { type: "h1" | "h2" | "p" | "li"; text: string };
  const blocks: Block[] = [];
  const para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    blocks.push({ type: "p", text: para.join(" ") });
    para.length = 0;
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^###\s/.test(line) || /^##\s/.test(line)) {
      flush();
      blocks.push({ type: "h2", text: line.replace(/^#{2,3}\s+/, "") });
    } else if (/^#\s/.test(line)) {
      flush();
      blocks.push({ type: "h1", text: line.replace(/^#\s+/, "") });
    } else if (/^[-*]\s/.test(line)) {
      flush();
      blocks.push({ type: "li", text: line.replace(/^[-*]\s+/, "") });
    } else if (line.trim() === "") {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  const omit = props.omitTitle?.trim().toLowerCase();
  const firstH1 = blocks.findIndex((b) => b.type === "h1");
  if (
    omit &&
    firstH1 >= 0 &&
    blocks[firstH1]!.text.replace(/\*\*/g, "").trim().toLowerCase() === omit
  ) {
    blocks.splice(firstH1, 1);
  }
  return (
    <div class="manuscript">
      {split.fence !== null ? (
        (ManuscriptRecord({
          text: props.text,
          hasHeading: Boolean(omit) || blocks.some((b) => b.type === "h1"),
        }) ?? (
          <pre class="raw ms-fence">{`---\n${split.fence}\n---`}</pre>
        ))
      ) : null}
      {blocks.map((b, i) => {
        if (b.type === "h1") {
          return (
            <h1 class="ms-h1" key={i}>
              {renderInline(b.text)}
            </h1>
          );
        }
        if (b.type === "h2") {
          return (
            <h2 class="ms-h2" key={i}>
              {renderInline(b.text)}
            </h2>
          );
        }
        if (b.type === "li") {
          return (
            <p class="ms-li" key={i}>
              {renderInline(b.text)}
            </p>
          );
        }
        return (
          <p class="ms-p" key={i}>
            {renderInline(b.text)}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Beats and quests stay as their source text; each line is its own block so
 * headings and list items can be set like a printed page.
 */
export function SourceLines(props: { text: string }) {
  const lines = props.text.replace(/\s+$/, "").split(/\r?\n/);
  return (
    <div class="raw source-lines">
      {lines.map((line, i) => {
        const kind = /^#{1,6}\s/.test(line)
          ? "is-heading"
          : /^\s*[-*]\s/.test(line)
            ? "is-item"
            : line.trim() === ""
              ? "is-gap"
              : "is-text";
        return (
          <div key={i} class={`source-line ${kind}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
