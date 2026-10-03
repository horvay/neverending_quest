/** An engraved printer's ornament, used as a section rule. */
export function Fleuron(props: { class?: string }) {
  return (
    <img
      class={`fleuron${props.class ? ` ${props.class}` : ""}`}
      src="/ink/fleuron.webp"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** A small quill, for writing affordances. */
export function QuillIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M20.7 2.6c-5.6.6-10.3 3.6-12.9 8.4-.9 1.7-1.5 3.4-1.8 5.2l-2.3 4.3c-.2.4.2.8.6.6l4.3-2.3c1.8-.3 3.5-.9 5.2-1.8 2.2-1.2 3.9-2.8 5.1-4.7l-3.3.2 3.9-2.4c.8-1.6 1.3-3.4 1.6-5.3.1-.5-.3-.9-.8-.8l.4-.1zM8.4 15.6l5.8-6.2-6.6 5.6c.2.2.5.4.8.6z"
      />
    </svg>
  );
}
