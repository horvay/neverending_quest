/**
 * Extract the player-facing first message from seed.md.
 *
 * Authors put it under a level-2 heading:
 *
 *   ## Opening message
 *
 *   Prose shown on first `nq play` when the transcript is still empty.
 *
 * The body runs until the next `## ` heading (any title) or end of file.
 * Missing / blank sections return null.
 */
export function extractOpeningMessage(seedMarkdown: string): string | null {
  const lines = seedMarkdown.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+opening\s+message\s*$/i.test(line.trimEnd())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+\S/.test(line)) break;
    body.push(line);
  }

  const text = body.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return text.length > 0 ? text : null;
}
