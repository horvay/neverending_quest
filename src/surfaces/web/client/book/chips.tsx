import type { ComponentChildren } from "preact";

function ChipButton(props: {
  label: string;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

export function WhoChip(props: {
  reveal: boolean;
  scratchOpen: boolean;
  busy: boolean;
  isGm: boolean;
  isLast: boolean;
  hasScratch: boolean;
  onEdit?: () => void;
  onContinue?: () => void;
  onScratch?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
}) {
  const showActions = props.reveal;
  const showScratch = props.hasScratch && (props.reveal || props.scratchOpen);
  if (!showActions && !showScratch) return null;
  return (
    <span class="who-actions">
      {showActions && props.onEdit ? (
        <ChipButton
          label="Edit"
          disabled={props.busy || !props.onEdit}
          onClick={() => props.onEdit?.()}
        >
          Edit
        </ChipButton>
      ) : null}
      {showActions && props.isGm && props.onContinue ? (
        <ChipButton
          label="Continue"
          disabled={props.busy}
          onClick={() => props.onContinue?.()}
        >
          Continue
        </ChipButton>
      ) : null}
      {showScratch && props.onScratch ? (
        <ChipButton
          label={props.scratchOpen ? "Collapse scratch" : "Expand scratch"}
          expanded={props.scratchOpen}
          disabled={props.busy}
          onClick={() => props.onScratch?.()}
        >
          Scratch
        </ChipButton>
      ) : null}
      {showActions && props.isLast && props.onRetry ? (
        <ChipButton
          label="Retry"
          disabled={props.busy}
          onClick={() => props.onRetry?.()}
        >
          Retry
        </ChipButton>
      ) : null}
      {showActions && props.isLast && props.onDelete ? (
        <ChipButton
          label="Strike"
          disabled={props.busy}
          onClick={() => props.onDelete?.()}
        >
          Strike
        </ChipButton>
      ) : null}
    </span>
  );
}
