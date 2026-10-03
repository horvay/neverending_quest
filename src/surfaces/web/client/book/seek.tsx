export function DossierIndexRow(props: {
  name: string;
  excerpt: string;
  archived: boolean;
  locked: boolean;
  onOpen: () => void;
  onFile?: () => void;
}) {
  return (
    <li class={props.archived ? "dossier-row filed" : "dossier-row"}>
      <button type="button" class="dossier-open" onClick={props.onOpen}>
        {props.name}
      </button>
      {props.onFile ? (
        <button
          type="button"
          class="file-leaf"
          disabled={props.locked}
          onClick={props.onFile}
        >
          {props.archived ? "Restore this leaf" : "Archive"}
        </button>
      ) : null}
      {props.excerpt ? <p class="dossier-hit">{props.excerpt}</p> : null}
    </li>
  );
}

export function LeafSearch(props: {
  id: string;
  value: string;
  hint: string;
  onInput: (value: string) => void;
}) {
  return (
    <div class="leaf-search">
      <label class="leaf-kicker" for={props.id}>
        Seek
      </label>
      <input
        id={props.id}
        type="text"
        value={props.value}
        placeholder={props.hint}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}
