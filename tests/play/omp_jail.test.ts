import { describe, expect, test } from "bun:test";
import { createSandboxJailExtension } from "../../src/agent/omp/tools.ts";
import { createSandbox } from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

type ToolCallHandler = (event: {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;

describe("OMP path-jail extension", () => {
  test("blocks escaped and protected write targets; allows sheet read", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sandbox = await createSandbox({ campaignRoot: campaign });
      const factory = createSandboxJailExtension(sandbox);

      let handler: ToolCallHandler | undefined;
      factory({
        on(event: string, h: ToolCallHandler) {
          if (event === "tool_call") handler = h;
        },
      } as never);

      expect(handler).toBeTypeOf("function");

      const escape = await handler!({
        type: "tool_call",
        toolCallId: "1",
        toolName: "read",
        input: { path: "../secret.txt" },
      });
      expect(escape?.block).toBe(true);
      expect(escape?.reason).toMatch(/escape|denied|Campaign/i);

      const protectedWrite = await handler!({
        type: "tool_call",
        toolCallId: "2",
        toolName: "write",
        input: { path: "transcript.jsonl", content: "nope" },
      });
      expect(protectedWrite?.block).toBe(true);

      const nq = await handler!({
        type: "tool_call",
        toolCallId: "3",
        toolName: "edit",
        input: { path: ".nq/sessions/x.jsonl" },
      });
      expect(nq?.block).toBe(true);

      const ok = await handler!({
        type: "tool_call",
        toolCallId: "4",
        toolName: "read",
        input: { path: "player_sheet.md" },
      });
      expect(ok).toBeUndefined();

      const ignored = await handler!({
        type: "tool_call",
        toolCallId: "5",
        toolName: "roll",
        input: { n: 6 },
      });
      expect(ignored).toBeUndefined();

      const hashlineEdit = await handler!({
        type: "tool_call",
        toolCallId: "6",
        toolName: "edit",
        input: {
          input: "[player_sheet.md#ABCD]\nSWAP 1.=1:\n+# ok\n",
        },
      });
      expect(hashlineEdit).toBeUndefined();

      const hashlineEscape = await handler!({
        type: "tool_call",
        toolCallId: "7",
        toolName: "edit",
        input: {
          input: "[../secret.txt#ABCD]\nSWAP 1.=1:\n+# no\n",
        },
      });
      expect(hashlineEscape?.block).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});
