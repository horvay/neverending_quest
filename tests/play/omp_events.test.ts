import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage, type as schema } from "@oh-my-pi/pi-ai";
import {
  createAgentSession,
  SessionManager,
  Settings,
  type AgentSession as OmpAgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  createMockModel,
  registerMockApi,
} from "@oh-my-pi/pi-ai/providers/mock";
import type {
  MockHandler,
  MockModel,
  MockResponse,
} from "@oh-my-pi/pi-ai/providers/mock";
import { createOmpAgentFactory } from "../../src/agent/omp/factory.ts";
import { mapOmpEvent } from "../../src/agent/omp/events.ts";
import { adaptOmpSession } from "../../src/agent/omp/session_adapter.ts";
import type { AgentSession } from "../../src/play/types.ts";
import {
  createInitialResponsesAssistantMessage,
  processResponsesStream,
} from "../../node_modules/@oh-my-pi/pi-ai/src/providers/openai-shared.ts";
import type { ResponseStreamEvent } from "../../node_modules/@oh-my-pi/pi-ai/src/providers/openai-responses-wire.ts";
import type { AssistantMessageEvent } from "../../node_modules/@oh-my-pi/pi-ai/src/types.ts";
import { AssistantMessageEventStream } from "../../node_modules/@oh-my-pi/pi-ai/src/utils/event-stream.ts";

describe("OMP retry classification", () => {
  test("retries the failed request and returns the Game Master reply", async () => {
    registerMockApi();
    const mock = createMockModel({
      responses: [
        {
          stopReason: "error",
          errorMessage:
            "Error Code unknown: Service temporarily unavailable. The model did not respond to this request.",
        },
        { content: ["Issa tells you what happened."] },
      ],
    });
    const settings = Settings.isolated({
      "compaction.enabled": false,
      "goal.enabled": false,
      "memory.backend": "off",
      "retry.baseDelayMs": 1,
      "retry.maxDelayMs": 10,
      "retry.maxRetries": 1,
      "retry.modelFallback": false,
    });
    const authStorage = await AuthStorage.create(":memory:");
    authStorage.setConfigApiKey("mock", "test-key");
    const modelRegistry = new ModelRegistry(authStorage);
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model: mock.model,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settings,
      contextFiles: [],
      skills: [],
      rules: [],
      promptTemplates: [],
      slashCommands: [],
      toolNames: [],
      restrictToolNames: true,
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      disableExtensionDiscovery: true,
    });

    try {
      await session.prompt('"Do you know how they died?"', {
        expandPromptTemplates: false,
      });

      expect(mock.calls).toHaveLength(2);
      expect(session.getLastAssistantMessage()?.content).toEqual([
        { type: "text", text: "Issa tells you what happened." },
      ]);
    } finally {
      await session.dispose();
      authStorage.close();
    }
  });
});

describe("OMP event mapping", () => {
  test("OpenRouter reasoning.delta becomes live thinking", async () => {
    const responseStream = new AssistantMessageEventStream();
    const model = createMockModel({
      id: "z-ai/glm-5.2:free",
      provider: "openrouter",
    }).model;
    const output = createInitialResponsesAssistantMessage(
      "openrouter",
      "openrouter",
      "z-ai/glm-5.2:free",
    );
    async function* asStream() {
      yield {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      };
      yield {
        type: "response.reasoning.delta",
        output_index: 0,
        item_id: "rs_1",
        delta: "Need a town.",
      };
      yield {
        type: "response.reasoning.delta",
        output_index: 0,
        item_id: "rs_1",
        delta: " Ask where.",
      };
      yield {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Need a town. Ask where." }],
        },
      };
    }
    await processResponsesStream(
      asStream() as AsyncIterable<ResponseStreamEvent>,
      output,
      responseStream,
      model,
    );
    const thinkingEvents = responseStream.queue.filter(
      (
        event,
      ): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
        event.type === "thinking_delta",
    );
    expect(thinkingEvents.map(({ type, delta }) => ({ type, delta }))).toEqual([
      { type: "thinking_delta", delta: "Need a town." },
      { type: "thinking_delta", delta: " Ask where." },
    ]);
    const mapped = thinkingEvents
      .map((ev) =>
        mapOmpEvent({
          type: "message_update",
          assistantMessageEvent: ev,
        }),
      )
      .filter((ev) => ev?.type === "thinking_delta");
    expect(mapped).toEqual([
      { type: "thinking_delta", text: "Need a town." },
      { type: "thinking_delta", text: " Ask where." },
    ]);
  });

});

interface HiddenHistoryHarness {
  adapted: AgentSession;
  authStorage: AuthStorage;
  memoryFile: string;
  mock: MockModel;
  root: string;
  session: OmpAgentSession;
  sessionsDir: string;
}

async function createHiddenHistoryHarness(
  responses: MockHandler[],
): Promise<HiddenHistoryHarness> {
  registerMockApi();
  const root = await mkdtemp(path.join(os.tmpdir(), "nq-hidden-history-"));
  const sessionsDir = path.join(root, ".nq", "sessions");
  const memoryFile = path.join(root, "story-beats.md");
  const mock = createMockModel({ responses });
  const authStorage = await AuthStorage.create(":memory:");
  authStorage.setConfigApiKey("mock", "test-key");
  const modelRegistry = new ModelRegistry(authStorage);
  const sessionManager = SessionManager.create(root, sessionsDir);
  const settings = Settings.isolated({
    "compaction.enabled": false,
    "goal.enabled": false,
    "memory.backend": "off",
    "retry.maxRetries": 0,
    "retry.modelFallback": false,
  });
  const { session } = await createAgentSession({
    cwd: root,
    model: mock.model,
    modelRegistry,
    sessionManager,
    settings,
    systemPrompt: "You are the Game Master.",
    contextFiles: [],
    skills: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    toolNames: [],
    restrictToolNames: false,
    customTools: [
      {
        name: "play_probe",
        label: "Play probe",
        description: "Available during ordinary play.",
        parameters: schema({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "play" }] };
        },
      },
      {
        name: "maintenance_write",
        label: "Maintenance write",
        description: "Writes a Memory Hygiene fixture.",
        parameters: schema({ text: "string" }),
        async execute(_id: string, params: { text: string }) {
          await Bun.write(memoryFile, params.text);
          return { content: [{ type: "text" as const, text: "written" }] };
        },
      },
    ],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    disableExtensionDiscovery: true,
  });
  await session.setActiveToolsByName(["play_probe"]);
  const adapted = adaptOmpSession(session, root, {
    cwd: root,
    sessionsDir,
    sessionManager,
    sandbox: {} as never,
    systemPrompt: "You are the Game Master.",
    contextFiles: [],
    toolNames: ["play_probe"],
  });

  return {
    adapted,
    authStorage,
    memoryFile,
    mock,
    root,
    session,
    sessionsDir,
  };
}

async function closeHiddenHistoryHarness(harness: HiddenHistoryHarness) {
  await harness.adapted.end();
  harness.authStorage.close();
  await rm(harness.root, { recursive: true, force: true });
}

function requestHistory(harness: HiddenHistoryHarness, index: number): string {
  return JSON.stringify(harness.mock.calls[index]?.context.messages ?? []);
}

async function expectResumedJournalClean(harness: HiddenHistoryHarness) {
  const resumed = await SessionManager.continueRecent(
    harness.root,
    harness.sessionsDir,
  );
  try {
    const history = JSON.stringify(resumed.getBranch());
    expect(history).toContain('"state":"clean"');
    expect(history).toContain("The brass door opens.");
    expect(history).not.toContain("MAINTENANCE ONLY");
    expect(history).not.toContain("maintenance_write");
    expect(history).not.toContain("Maintenance complete.");
  } finally {
    await resumed.close();
  }
}

describe("OMP hidden prompt history", () => {
  test("rejects an unmarked legacy journal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nq-legacy-history-"));
    const sessionsDir = path.join(root, ".nq", "sessions");
    const legacy = SessionManager.create(root, sessionsDir);
    legacy.appendMessage({
      role: "user",
      content: "legacy player turn",
      timestamp: Date.now(),
    });
    await legacy.close();
    try {
      const resumed = await createOmpAgentFactory().continueRecent?.({
        cwd: root,
        sessionsDir,
        systemPrompt: "You are the Game Master.",
        contextFiles: [],
        sandbox: {} as never,
        transcriptDigest: "",
      });
      expect(resumed).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps tool traffic and summary out of the next request after success", async () => {
    const harness = await createHiddenHistoryHarness([
      { content: ["The brass door opens."] },
      {
        content: [
          {
            type: "toolCall",
            name: "maintenance_write",
            arguments: { text: "A durable beat." },
          },
        ],
      },
      { content: ["Maintenance complete."] },
      { content: ["The corridor continues."] },
    ]);
    const events: string[] = [];
    const unsubscribe = harness.adapted.subscribe((event) => {
      events.push(event.type);
    });
    try {
      await harness.adapted.prompt("Open the brass door.");
      const result = await harness.adapted.prompt("MAINTENANCE ONLY", {
        hidden: true,
        toolNames: ["maintenance_write"],
      });

      expect(result).toEqual({ prose: "Maintenance complete." });
      expect(await Bun.file(harness.memoryFile).text()).toBe("A durable beat.");
      expect(events).toContain("tool_call");
      expect(events).toContain("tool_result");
      await expectResumedJournalClean(harness);

      await harness.adapted.prompt("Continue down the corridor.");
      const nextRequest = requestHistory(harness, 3);
      expect(nextRequest).toContain("Open the brass door.");
      expect(nextRequest).toContain("The brass door opens.");
      expect(nextRequest).not.toContain("MAINTENANCE ONLY");
      expect(nextRequest).not.toContain("maintenance_write");
      expect(nextRequest).not.toContain("Maintenance complete.");
      expect(
        harness.mock.calls[3]?.context.tools?.map((tool) => tool.name),
      ).toEqual(["play_probe"]);
    } finally {
      unsubscribe();
      await closeHiddenHistoryHarness(harness);
    }
  });

  test("restores history after a provider error", async () => {
    const harness = await createHiddenHistoryHarness([
      { content: ["The brass door opens."] },
      { stopReason: "error", errorMessage: "maintenance provider failed" },
      { content: ["The corridor continues."] },
    ]);
    try {
      await harness.adapted.prompt("Open the brass door.");
      const result = await harness.adapted.prompt("MAINTENANCE ONLY", {
        hidden: true,
        toolNames: ["maintenance_write"],
      });

      expect(result.error).toContain("maintenance provider failed");
      await expectResumedJournalClean(harness);
      await harness.adapted.prompt("Continue down the corridor.");
      const nextRequest = requestHistory(harness, 2);
      expect(nextRequest).not.toContain("MAINTENANCE ONLY");
      expect(nextRequest).not.toContain("maintenance provider failed");
      expect(
        harness.mock.calls[2]?.context.tools?.map((tool) => tool.name),
      ).toEqual(["play_probe"]);
    } finally {
      await closeHiddenHistoryHarness(harness);
    }
  });

  test("restores history after cancellation", async () => {
    let markHiddenStarted: (() => void) | undefined;
    const hiddenStarted = new Promise<void>((resolve) => {
      markHiddenStarted = resolve;
    });
    const harness = await createHiddenHistoryHarness([
      { content: ["The brass door opens."] },
      (_context, options) => {
        markHiddenStarted?.();
        return new Promise<MockResponse>((resolve) => {
          const finish = () =>
            resolve({
              stopReason: "aborted",
              errorMessage: "maintenance cancelled",
            });
          if (options?.signal?.aborted) {
            finish();
          } else {
            options?.signal?.addEventListener("abort", finish, { once: true });
          }
        });
      },
      { content: ["The corridor continues."] },
    ]);
    const controller = new AbortController();
    try {
      await harness.adapted.prompt("Open the brass door.");
      // in sync, so only the in-flight hidden pass can make resume unsafe
      harness.adapted.markTranscriptSync?.("story");
      const pending = harness.adapted.prompt("MAINTENANCE ONLY", {
        hidden: true,
        signal: controller.signal,
        toolNames: ["maintenance_write"],
      });
      await hiddenStarted;
      const unsafeResume = await createOmpAgentFactory().continueRecent?.({
        cwd: harness.root,
        sessionsDir: harness.sessionsDir,
        systemPrompt: "You are the Game Master.",
        contextFiles: [],
        sandbox: {} as never,
        transcriptDigest: "story",
      });
      expect(unsafeResume).toBeNull();
      controller.abort();
      const result = await pending;

      expect(result).toEqual({ prose: "", aborted: true, error: "aborted" });
      await expectResumedJournalClean(harness);
      await harness.adapted.prompt("Continue down the corridor.");
      const nextRequest = requestHistory(harness, 2);
      expect(nextRequest).not.toContain("MAINTENANCE ONLY");
      expect(nextRequest).not.toContain("Maintenance complete.");
      expect(
        harness.mock.calls[2]?.context.tools?.map((tool) => tool.name),
      ).toEqual(["play_probe"]);
    } finally {
      await closeHiddenHistoryHarness(harness);
    }
  });
});
