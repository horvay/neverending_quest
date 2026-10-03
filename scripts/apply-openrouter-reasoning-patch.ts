import { readFile, writeFile } from "node:fs/promises";

const SHARED = "node_modules/@oh-my-pi/pi-ai/src/providers/openai-shared.ts";
const RESPONSES = "node_modules/@oh-my-pi/pi-ai/src/providers/openai-responses.ts";

const MARKER = "isOpenRouterReasoningDelta";

const HELPER = `
function isOpenRouterReasoningDelta(
	event: { type?: string; delta?: unknown },
): event is { type: string; delta: string; output_index?: number; item_id?: string } {
	return event.type === "response.reasoning.delta" && typeof event.delta === "string";
}
`;

const HANDLER = `		} else if (isOpenRouterReasoningDelta(event)) {
			// OpenRouter Responses streams GLM/Qwen thinking as \`response.reasoning.delta\`,
			// not OpenAI's \`response.reasoning_text.delta\`.
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {`;

async function patchFile(path: string, apply: (src: string) => string): Promise<void> {
  let src: string;
  try {
    src = await readFile(path, "utf8");
  } catch {
    return;
  }
  const next = apply(src);
  if (next !== src) await writeFile(path, next);
}

await patchFile(SHARED, (src) => {
  if (src.includes(MARKER)) return src;
  let out = src.replace(
    `\t"response.reasoning_text.delta",\n\t"response.content_part.added",`,
    `\t"response.reasoning_text.delta",\n\t"response.reasoning.delta",\n\t"response.reasoning.done",\n\t"response.content_part.added",`,
  );
  out = out.replace(
    `export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {`,
    `${HELPER}\nexport function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {`,
  );
  out = out.replace(
    `		} else if (event.type === "response.content_part.added") {`,
    HANDLER,
  );
  if (!out.includes(MARKER)) {
    throw new Error(`openrouter reasoning patch did not apply to ${SHARED}`);
  }
  return out;
});

await patchFile(RESPONSES, (src) => {
  if (src.includes("response.reasoning.delta")) return src;
  const next = src.replace(
    `\t\tdefault:\n\t\t\treturn false;`,
    `\t\tdefault:\n\t\t\treturn (\n\t\t\t\t(event as { type?: string }).type === "response.reasoning.delta" &&\n\t\t\t\ttypeof (event as { delta?: unknown }).delta === "string" &&\n\t\t\t\t(event as { delta: string }).delta.length > 0\n\t\t\t);`,
  );
  if (next === src) {
    throw new Error(`openrouter reasoning patch did not apply to ${RESPONSES}`);
  }
  return next;
});
