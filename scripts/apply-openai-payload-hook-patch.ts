import { readFile, writeFile } from "node:fs/promises";

const TARGET =
  "node_modules/@oh-my-pi/pi-ai/src/providers/openai-completions.ts";
const MARKER =
  "const replacementPayload = await options?.onPayload?.(requestParams, model);";

let source: string;
try {
  source = await readFile(TARGET, "utf8");
} catch {
  process.exit(0);
}

if (source.includes(MARKER)) process.exit(0);

let patched = source.replace(
  `\t\t\t\tactiveRequestParams = params;\n\t\t\t\toptions?.onPayload?.(params, model);`,
  `\t\t\t\tlet requestParams = params;\n\t\t\t\tconst replacementPayload = await options?.onPayload?.(requestParams, model);\n\t\t\t\tif (replacementPayload !== undefined) {\n\t\t\t\t\trequestParams = replacementPayload as OpenAICompletionsParams;\n\t\t\t\t}\n\t\t\t\tactiveRequestParams = requestParams;`,
);
patched = patched.replace(
  `\t\t\t\t\tbody: params,\n\t\t\t\t};\n\t\t\t\tlet requestTimeout`,
  `\t\t\t\t\tbody: requestParams,\n\t\t\t\t};\n\t\t\t\tlet requestTimeout`,
);
patched = patched.replace(
  `\t\t\t\t\t\tbody: params,\n\t\t\t\t\t\tsignal: requestSignal,`,
  `\t\t\t\t\t\tbody: requestParams,\n\t\t\t\t\t\tsignal: requestSignal,`,
);

if (!patched.includes(MARKER)) {
  throw new Error(`OpenAI payload hook patch did not apply to ${TARGET}`);
}
if (patched === source) {
  throw new Error(`OpenAI payload hook patch made no changes to ${TARGET}`);
}
await writeFile(TARGET, patched);
