# Every Player Surface offers the same play

Status: **accepted** 2026-10-01. Reopens part of [ADR-0006](0006-play-authoring.md) ("TUI memory editor — rejected; Inspect write is `nq serve` only").

The terminal (`nq play`) and the web book (`nq serve`, the Hosted book) offer the same play and the same Home. A player feature is built once, in the Play Loop (`PlaySessionApi`) or in Home (`HomeSurface`). Each surface then renders it in its own medium.

**Why:** The terminal had fallen behind the web book. It had no Retry, Answer now, Luck Points, Roll Log, Inspect, Illustration, play settings or AI log, and its Home had no "This computer" setup, Settings or Almanac. Each new feature was built straight into the web book, so the gap kept growing. Keeping the features below both surfaces makes parity cheap. The surfaces only translate.

## What the terminal does differently, on purpose

- Commands are slash commands with `/help`; the input stays open while the Game Master works so `/stop` and `/answer` can be typed. Anything that writes is refused while busy with the same words as the web book.
- Inspect shows raw markdown and inks through the same overlay as transcript Edit. A save checks the hash the ink started from, so a change on disk is never overwritten.
- Illustration paints the same four sittings; `/look` opens a picture in the system viewer (`xdg-open`) instead of drawing it.
- A roll is a one-line notice, not the dice animation. The AI log is a snapshot of its tail, not a live drawer. Typeface and text size are browser-only.

## Consequences

- Shared pure helpers that both surfaces render from (leaf names, the Seek ranking, the Status colophon, the Roll Log) live in `src/play/` or `src/surfaces/shared/`, not in either surface.
- `PlaySessionApi` gained `inspect()` and `illustrationFile()`, so no surface reads the Campaign folder itself.
- Deep tests drive each surface's journeys over the real Home, Play Loop and Campaign folder (`tests/play/tui_play_parity.test.ts`, `tests/play/web_book_flows.test.tsx`).
