import { TABS } from "../../../shared/leaves.ts";

export function MarkIcon(props: { id: (typeof TABS)[number] }) {
  const common = {
    width: "22",
    height: "22",
    viewBox: "0 0 20 20",
    "aria-hidden": "true" as const,
  };
  switch (props.id) {
    case "quests":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M10 1.6 16.2 7.8 10 14 3.8 7.8 10 1.6zm0 2.5L6.3 7.8 10 11.5l3.7-3.7L10 4.1z"
          />
          <path fill="currentColor" d="M9.15 13.2h1.7v5.2H9.15z" />
        </svg>
      );
    case "twists":
      return (
        <svg {...common}>
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10 18v-5.2m0 0L5.6 8.4m4.4 4.4 4.4-4.4"
          />
          <circle cx="5.6" cy="6.6" r="1.9" fill="currentColor" />
          <circle cx="14.4" cy="6.6" r="1.9" fill="currentColor" />
        </svg>
      );
    case "beats":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M13.8 2.2c.2 2.1-1.3 4.6-3.8 6.6-.3.2-.8 0-.9-.4-.2-1.1.1-2.2.7-3.1-1.7 1-3.1 2.6-3.4 4.6-.4 2.8.6 5.2 2.6 7.1.3.3.8.2 1-.2.4-.7.6-1.5.6-2.3 2.4-1.3 4.6-3.6 5.2-6.4.7-3.1-.4-5.2-2-5.9zM7.6 10.6c.4-1.4 1.4-2.6 2.6-3.5-.2.9-.2 1.8.1 2.6-1.1.4-2 1.2-2.7 2.2 0-.4 0-.9 0-1.3z"
          />
        </svg>
      );
    case "sheet":
      return (
        <svg {...common}>
          <circle cx="10" cy="6.1" r="3.15" fill="currentColor" />
          <path
            fill="currentColor"
            d="M3.4 17.4c.5-3.6 3-5.5 6.6-5.5s6.1 1.9 6.6 5.5c.1.5-.3 1-1 1H4.4c-.7 0-1.1-.5-1-1z"
          />
        </svg>
      );
    case "world":
      return (
        <svg {...common}>
          <circle
            cx="10"
            cy="10"
            r="6.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          />
          <ellipse
            cx="10"
            cy="10"
            rx="3.1"
            ry="6.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            d="M3.5 10h13"
          />
        </svg>
      );
    case "dossiers":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M3.2 5.6c0-.7.5-1.2 1.2-1.2h3.3l1.3 1.5h6.6c.7 0 1.2.5 1.2 1.2v7.8c0 .7-.5 1.2-1.2 1.2H4.4c-.7 0-1.2-.5-1.2-1.2V5.6z"
          />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            fill-rule="evenodd"
            d="M8.6 1.8h2.8l.4 2.1c.5.2 1 .5 1.4.8l2-.8 1.4 2.4-1.6 1.4c.1.5.1 1 0 1.5l1.6 1.4-1.4 2.4-2-.8c-.4.3-.9.6-1.4.8l-.4 2.1H8.6l-.4-2.1c-.5-.2-1-.5-1.4-.8l-2 .8-1.4-2.4 1.6-1.4a4.6 4.6 0 0 1 0-1.5L3.4 6.3l1.4-2.4 2 .8c.4-.3.9-.6 1.4-.8l.4-2.1zM10 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z"
          />
        </svg>
      );
    case "status":
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M10 2.2 16.8 4.6v5.3c0 3.7-2.7 6.2-6.8 7.2-4.1-1-6.8-3.5-6.8-7.2V4.6L10 2.2zm0 2.1L5 5.7v4.2c0 2.5 1.8 4.4 5 5.3 3.2-.9 5-2.8 5-5.3V5.7L10 4.3z"
          />
          <path
            fill="currentColor"
            d="M9.1 12.5 6.6 10l1.1-1.1 1.4 1.4 3.2-3.2L13.4 8z"
          />
        </svg>
      );
  }
}
