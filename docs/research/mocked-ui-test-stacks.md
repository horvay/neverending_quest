# Mocked UI test stacks

Research note for ticket [Mocked UI test stacks](../../.scratch/nq-player-surfaces/issues/03-mocked-ui-test-stacks.md).
Does **not** write the test-strategy policy (later grilling ticket [Test strategy and realistic fixtures](../../.scratch/nq-player-surfaces/issues/11-test-strategy-and-realistic-fixtures.md)).

Primary sources, inspected 2026-08-13:

- [Bun test runner](https://bun.com/docs/test), [DOM testing](https://bun.com/docs/test/dom), [happy-dom guide](https://bun.com/docs/guides/test/happy-dom), [`Bun.serve`](https://bun.com/docs/runtime/http/server), [`Bun.WebView`](https://bun.com/docs/runtime/webview)
- [happy-dom wiki](https://github.com/capricorn86/happy-dom/wiki/Getting-started): [Setup as Test Environment](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment), [Global Registrator](https://github.com/capricorn86/happy-dom/wiki/Global-Registrator)
- [jsdom README](https://github.com/jsdom/jsdom)
- [DOM Testing Library](https://testing-library.com/docs/dom-testing-library/intro/), [Guiding Principles](https://testing-library.com/docs/guiding-principles), [Queries](https://testing-library.com/docs/queries/about/), [user-event](https://testing-library.com/docs/user-event/intro)
- [OpenTUI Testing](https://opentui.com/docs/core-concepts/testing/) and [Mintlify testing page](https://anomalyco-opentui.mintlify.app/advanced/testing); source [`packages/core/src/testing/test-renderer.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/testing/test-renderer.ts)
- Effect: [TestClock (v3)](https://www.effect.website/docs/v3/testing/testclock), [TestContext API](https://www.effect.website/docs/v3/api/effect/TestContext); HTTP test paths cross-checked against [Effect + Bun HTTP envelope](effect-bun-http-envelope.md) (`BunHttpServer.layerTest`, `HttpApp.toWebHandler`). v4 `makeTestClient` recorded only as the unused successor.
- Playwright: [Intro](https://playwright.dev/docs/intro) (runner is `npx playwright test`); Bun support request [#38095](https://github.com/microsoft/playwright/issues/38095) closed as not planned

Repo anchors used only to fit the stacks: existing `bun test` + `FakeAgentFactory`; helpers `tests/helpers/campaign.ts`, `tests/eval/apply_fixture.ts`; packs `packs/brinewatch`, `tests/eval/packs/memory-gym`; overlay `tests/eval/fixtures/dirty-midgame/`; `PlayEvent` in `src/play/types.ts`; inspect reader `src/campaign/show.ts`.

---

## Summary

| Surface | Recommended stack under `bun test` | What is mocked | What stays real | Source anchor |
| --- | --- | --- | --- | --- |
| **Web (mocked UI)** | `happy-dom` via `@happy-dom/global-registrator` + `@testing-library/dom` + `@testing-library/user-event`. Feed a fake `PlayEvent` source (or a `PlayLoop` + `FakeAgentFactory`). Assert with `screen.getByRole` / `getByText` / `findBy*` | Play Loop / Provider / live HTTP | DOM queries, user typing/click, Campaign markdown when inspect is under test | Bun [DOM testing](https://bun.com/docs/test/dom); [happy-dom Bun setup](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment); Testing Library [queries](https://testing-library.com/docs/queries/about/) |
| **OpenTUI (mocked UI)** | `@opentui/core/testing`: `createTestRenderer` + `mockInput` + `renderOnce` / `waitForFrame` + `captureCharFrame` | Host tty / raw mode / process stdout | Native in-memory renderer, key encoding, layout | [OpenTUI Testing](https://opentui.com/docs/core-concepts/testing/) |
| **HTTP integration** (not mocked UI) | Effect v3 `HttpApp.toWebHandler` (no listen) or `BunHttpServer.layerTest` (`port: 0` + injected `HttpClient`). Bun-native fallback: `server.fetch(Request)`. Temp Campaign + `FakeAgentFactory` | Provider / live model | HTTP handler, Campaign folder, `PlayLoop` | [Effect HTTP envelope](effect-bun-http-envelope.md) §5; `Bun.serve` [Server Lifecycle](https://bun.com/docs/runtime/http/server) |
| **Effect layer** | Stay on `bun:test`. Pin **Effect 3.22.1** (not 4 RC). `Effect.provide(TestContext.TestContext)` + `TestClock.adjust`. Do **not** switch the runner to `@effect/vitest` | Wall clock / live randomness (when those services are used) | Surface Effects over the existing Promise Play Loop | [TestClock](https://www.effect.website/docs/v3/testing/testclock); [Effect HTTP envelope](effect-bun-http-envelope.md) |
| **Fixtures** | Reuse `packs/brinewatch` / `tests/eval/packs/memory-gym` + `dirty-midgame` for inspect and names. Script `PlayEvent` sequences for chrome states. Do not invent parallel `foo`/`bar` Campaign trees | Live Provider | Disk Campaign files, `showCampaign` reader | Testing Library [guiding principle](https://testing-library.com/docs/guiding-principles); this repo's `apply_fixture.ts` |
| **Do not adopt** | Playwright / `Bun.WebView` for mocked UI; jsdom as the default DOM; global happy-dom preload for every `bun test`; snapshot-only TUI; live Provider in UI tests; `@testing-library/react` unless the page is React | — | — | Playwright [#38095](https://github.com/microsoft/playwright/issues/38095); Bun [WebView is experimental](https://bun.com/docs/runtime/webview); OpenTUI examples use `toContain`, not snapshots |

---

## 1. Shared runner: stay on `bun test`

NQ already runs `bun test` with Jest-compatible `describe` / `test` / `expect` (`package.json` `"test": "bun test"`). Bun's runner is first-party for TypeScript, mocks, snapshots, preload, and DOM ([test runner](https://bun.com/docs/test)). The same document lists HappyDOM, DOM Testing Library, and React Testing Library under **UI & DOM testing**.

Implications that fit this repo:

- No second test runner for Player Surfaces. Playwright Test (`npx playwright test`) and `@effect/vitest` (`it.effect`) are different runners.
- Existing doubles stay: `FakeAgentFactory` / `FakeAgentSession` (`src/dev/fake_agent.ts`) already script `prose_delta` and Turn outcomes without a Provider. CLI tests already set `NQ_FAKE_AGENT=1`.
- `PlayEvent` is the fake event-source vocabulary: `turn_started`, `prose_delta`, `turn_ended`, `status`, `error`, `hygiene_*`, `compact_*` (`src/play/types.ts`). Surfaces under test consume this stream, not OMP tool traces (`agent_debug` is off the default player surface).

---

## 2. Web Player Surface (mocked UI)

### 2.1 DOM environment: happy-dom, not jsdom

Bun's official recommendation is **happy-dom** ([DOM testing](https://bun.com/docs/test/dom), [guide](https://bun.com/docs/guides/test/happy-dom)):

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

preload via `bunfig.toml` `[test] preload = ["./happydom.ts"]`, then tests use `document` / `window`.

happy-dom's own wiki confirms Bun is a first-class test environment and that Testing Library works out of the box ([Setup as Test Environment](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment)). `GlobalRegistrator.register({ url, width, height })` injects a `Window`; `unregister()` restores the previous globals ([Global Registrator](https://github.com/capricorn86/happy-dom/wiki/Global-Registrator)).

**jsdom** is a complete WHATWG DOM/HTML implementation aimed at Node ([jsdom README](https://github.com/jsdom/jsdom)). Testing Library's setup page still documents jsdom + `global-jsdom` as the *without Jest* path ([Using Without Jest](https://testing-library.com/docs/dom-testing-library/setup/#using-without-jest)). That is historical Node/Jest guidance, not Bun's recommendation. Tradeoffs:

| | happy-dom | jsdom |
| --- | --- | --- |
| Bun first-party | Yes — only DOM env Bun documents | Not documented on bun.com/docs/test/dom |
| happy-dom first-party | Explicit Bun + Testing Library pages | N/A |
| Fidelity | Fast in-JS browser subset; Fetch, custom elements, MutationObserver | Broader spec surface; still no layout/navigation |
| Cost for NQ | Extra devDep + registrator | Extra devDep + no Bun guide; heavier |

**Fact:** for `bun test`, happy-dom is the documented default. jsdom is viable if a specific API is missing; it is not the stack to start on.

**Tradeoff — global preload.** Official Bun snippets register happy-dom for the whole `bun test` process. Today every file is a Node-style CLI/Play Loop test. A global `document` can hide accidental DOM coupling and adds timer/window globals. happy-dom supports per-file `register()` / `unregister()`. Safer fit: register only in web test files (or `bun test tests/web --preload ./happydom.ts`), not in the repo-wide preload that also runs `tests/play/*`.

### 2.2 Query and drive the page: Testing Library DOM + user-event

Bun lists [DOM Testing Library](https://testing-library.com/docs/dom-testing-library/intro/) as compatible. Use `@testing-library/dom`, not `@testing-library/react`, unless the web surface is actually React (that decision is [Browser page runtime](../../.scratch/nq-player-surfaces/issues/14-browser-page-runtime.md)). The DOM package works on plain HTML:

```ts
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";

document.body.innerHTML = /* rendered page */;
const user = userEvent.setup();
await user.type(screen.getByRole("textbox", { name: /you/i }), "I greet Mira");
await user.keyboard("{Enter}");
await screen.findByText(/Salt Lamp/);
```

Guiding principle: *the more your tests resemble the way your software is used, the more confidence they can give you* ([principles](https://testing-library.com/docs/guiding-principles)). Query priority ([queries](https://testing-library.com/docs/queries/about/#priority)):

1. `getByRole` (name option) — story region, status, Turn textbox, inspect tabs
2. `getByLabelText` — Turn input if it has a visible label
3. `getByText` — GM prose, hygiene copy, inspect file bodies
4. `getByTestId` — last resort for dynamic/unnamed chrome

`findBy*` / `waitFor` retry for streaming `prose_delta`. `queryBy*` asserts absence (hard-busy: Turn control not enabled; inspect pane not showing tool traces). `user-event` simulates full interactions (focus + keydown/input), not a single `dispatchEvent` ([user-event vs fireEvent](https://testing-library.com/docs/user-event/intro)).

`@testing-library/jest-dom` matchers (`toBeInTheDocument`, `toBeDisabled`) work if `expect.extend` is wired in a preload ([Bun DOM testing](https://bun.com/docs/test/dom)). Optional; `expect(el).toBeTruthy()` plus `aria-disabled` / `disabled` checks are enough.

### 2.3 Fake event source (no live Provider)

Two equivalent shapes; both keep the Provider out:

**A. View-model + scripted `PlayEvent[]` (thinnest).** Mount the page against an in-memory event bus. Push the same union the Play Loop already emits:

```ts
push({ type: "turn_started", playerText: "I greet Mira." });
push({ type: "prose_delta", text: "Mira wipes her hands on her apron." });
push({ type: "status", message: "Memory hygiene…" });
push({ type: "hygiene_started", mode: "light" });
push({ type: "turn_ended", outcome: "success", prose: "Mira wipes her hands on her apron." });
```

Assert: story region contains Mira / Salt Lamp; status shows hygiene; Turn control is disabled between `turn_started` and `turn_ended` (hard-busy); inspect pane is unchanged mid-Turn.

**B. Real `PlayLoop` + `FakeAgentFactory` + happy-dom page.** Same double the control-plane tests already use. The page's client is pointed at an in-process stream (function sink, not `EventSource` to a live port). Proves reducer + DOM together; slower than A.

Inspect panes should call the same `showCampaign` reader `nq show` uses (`src/campaign/show.ts` targets: `status`, `sheet`, `world`, `dossiers`, `beats`, `quests`, `transcript`) against a temp Campaign born from a real pack/overlay — not a stub `{ sheet: "foo" }`.

**Not this layer:** `fetch` to a listening `nq serve`. That is §4.

### 2.4 What to assert on the web surface

| Chrome | Query | Pass condition |
| --- | --- | --- |
| Story | `getByRole('log' / 'region')` or `findByText` on GM prose | Brinewatch names and multi-paragraph GM text appear; mid-turn `prose_delta` appends; `agent_debug` / tool names do not |
| Status | `getByRole('status')` or `getByText(/hygiene|compact/i)` | `status` / `hygiene_*` / `compact_*` events surface copy; idle after `*_ended` |
| Hard-busy | `getByRole('textbox')` + `toBeDisabled` / `aria-disabled` | Input ignored / disabled from `turn_started` until `turn_ended` |
| Inspect | `getByRole('tab' / 'region')` + `getByText` | `player_sheet.md` body (Ren Caldew, Salt-lung), dossier slugs (`mira-venn`, `kell-reed`), quest-log bullets, story-beats lines. Read-only: no contenteditable / file write control |

---

## 3. OpenTUI Player Surface (mocked UI)

OpenTUI ships a first-party harness on **Bun's test runner**. There is an official headless path; NQ does not need to invent a "record draw calls" fake. Sibling note [OpenTUI + Bun and testability](opentui-bun-and-testability.md) pins `@opentui/core@0.5.2` and records that the harness is a **real native `CliRenderer` with a memory destination** — not a JS-only mock and not a draw-call recorder that skips Zig.

### 3.1 `createTestRenderer` — real renderer, memory destination

[`@opentui/core/testing`](https://opentui.com/docs/core-concepts/testing/) constructs `CliRenderer` **directly**, skipping `createCliRenderer()` / `setupTerminal()`. Defaults that matter:

| Setting | Test default |
| --- | --- |
| `bufferedOutput` | `"memory"` (native bytes do not go to the host tty) |
| `consoleMode` | `"disabled"` |
| `screenMode` | `"main-screen"` |
| width / height | options, else 80×24 |

Returned setup (docs + [`test-renderer.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/testing/test-renderer.ts)): `renderer`, `mockInput`, `mockMouse`, `renderOnce()`, `flush()`, `waitFor()`, `waitForFrame()`, `waitForVisualIdle()`, `captureCharFrame()`, `captureSpans()`, `resize()`, `externalOutput`.

Tests **own cleanup**: `setup.renderer.destroy()` in `finally` / `afterEach`.

### 3.2 Drive keys, assert text

```ts
import { test, expect } from "bun:test";
import { createTestRenderer, KeyCodes } from "@opentui/core/testing";

test("hard-busy ignores input while Turning", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  try {
    // mount nq play chrome on setup.renderer.root
    await setup.mockInput.typeText("I greet Mira");
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame((t) => t.includes("Mira Venn"));
    expect(frame).toContain("Mira Venn");
    expect(frame).not.toContain("read("); // no tool traces
  } finally {
    setup.renderer.destroy();
  }
});
```

Keyboard ([docs](https://opentui.com/docs/core-concepts/testing/#keyboard-input)): `typeText`, `pressKey` / `KeyCodes.ENTER|ESCAPE|…`, `pressEnter`, `pressEscape`, modifiers `{ ctrl, shift, meta }`, `pasteBracketedText`. Mouse exists but v1 play chrome is story + single-line input; keyboard is the bar.

**When to wait:** `renderOnce()` for a single loop pass; `waitForFrame(predicate)` when `prose_delta` / Effect schedule work asynchronously (default 20 passes). `captureCharFrame()` decodes the character buffer as a string; `captureSpans()` adds cursor + styled spans.

`ManualClock` advances OpenTUI timers without wall-clock sleeps. That is the TUI analog of Effect `TestClock`.

### 3.3 Snapshots vs contain-assertions

`bun test` supports `toMatchSnapshot` ([snapshots](https://bun.com/docs/test)). OpenTUI's own testing pages demonstrate `expect(output).toContain(...)` and `waitForFrame((value) => value.includes(...))`, not snapshot-only bars. `TestRecorder` records frames for analysis, not as the pass/fail contract.

Tradeoff: a full 80×24 snapshot is brittle to width, wrapping, status-line wording, and color/span changes. `toContain` on player-visible strings (GM prose, `You>`, hygiene status, disabled-input behavior) matches how OpenTUI tests itself.

---

## 4. HTTP integration (not mocked UI)

Goal: `nq serve` against a **temp Campaign** + **`FakeAgentFactory`**, hit routes in-process, no live Provider.

### 4.1 Bun's first-party in-process hit: `server.fetch`

[`Bun.serve`](https://bun.com/docs/runtime/http/server) documents on the returned `Server`:

> `fetch(request: Request | string): Response | Promise<Response>` — *Make a request to the running server. Useful for testing or internal routing.*

That is the Bun-recommended way to exercise a local server from `bun test` without opening a browser and without writing `http://127.0.0.1:${port}` by hand. Complementary facts from the same page:

- `port: 0` binds an ephemeral port; read `server.port` / `server.url` if a real listen is required (SSE/WebSocket clients that cannot use `server.fetch`).
- `await server.stop()` (graceful) / `server.stop(true)` (force).
- `server.timeout(req, 0)` for long-lived SSE; default `idleTimeout` is 10s and **does** apply while streaming.
- `server.unref()` so a forgotten server does not hang `bun test`.

Sketch that fits NQ's existing temp-dir helpers:

```ts
const root = await makeTempDir();
const campaign = await birthDirtyMemoryGym(root);
const server = startNqServe({ path: campaign, factory: new FakeAgentFactory({ defaultProse: "Mira nods." }) });
try {
  const res = await server.fetch(new Request("http://nq/turn", { method: "POST", body: "I greet Mira" }));
  expect(res.ok).toBe(true);
  expect(await res.text()).toContain("Mira");
} finally {
  await server.stop(true);
  await rmTempDir(root);
}
```

`server.fetch` still runs the real `fetch` handler (routes, headers, streams). It is integration, not a mocked UI.

Existing CLI tests (`tests/cli/turn_cli.test.ts`) use `Bun.spawn(["bun", "run", "src/cli.ts", …])` plus `NQ_FAKE_AGENT`. That is a **process** integration, not in-process. Keep spawn for argv/exit-code; prefer `server.fetch` for the HTTP contract.

### 4.2 Effect HTTP test modules (v3 pin)

Sibling note [Effect + Bun HTTP envelope](effect-bun-http-envelope.md) pins **Effect 3.22.1 + `@effect/platform` 0.97.1 + `@effect/platform-bun` 0.91.2** (not 4 RC). There is **no** exported `TestHttpClient` type on that line. Official HTTP tests use two documented paths:

| Path | Binds a port? | What it is |
| --- | --- | --- |
| `HttpApp.toWebHandler` / `toWebHandlerRuntime` / `toWebHandlerLayer` | **No** | Turns the app into `(request: Request) => Promise<Response>`. Closest to Bun `server.fetch` without `Bun.serve`. Still honors `request.signal` → `clientAbortFiberId`. |
| `BunHttpServer.layerTest` | **Yes — `port: 0`** | Real ephemeral listen + injected `HttpClient` with the server URL prepended (`0.0.0.0` → `127.0.0.1`). Same contract as `NodeHttpServer.layerTest` / `HttpServer.layerTestClient`. Unix addresses rejected. |

`toWebHandler` is the in-process, no-socket hop for route/encoding unit tests. `layerTest` is the official Effect integration pattern (stream/WS clients that need a real URL). NQ can run either under `bun:test` with `Effect.provide(...)` — `@effect/vitest` is what Effect's own repo uses, not a requirement.

`TestContext.TestContext` + `TestClock` ([TestClock](https://www.effect.website/docs/v3/testing/testclock), [TestContext](https://www.effect.website/docs/v3/api/effect/TestContext)) still wrap time-dependent surface Effects. `Effect.runPromise` after `provide` is runner-agnostic.

**v4 only (do not take):** `HttpServer.makeTestClient` / `layerTestClient` / `layerServices` ([v4 API](https://www.effect.website/docs/v4/api/effect/unstable/http/HttpServer)). `layerServices` includes a **no-op `FileSystem`** — even if NQ later moves, inspect/Turn tests that read a Campaign folder must not use that layer as-is.

**Campaign FS:** platform `FileSystem` is optional for `nq serve` (envelope note: Campaign FS stays NQ-owned). `toWebHandler` / `layerTest` tests that inspect disk should keep using NQ's `showCampaign` + a temp dir, not a no-op FS.

### 4.3 What this layer proves vs mocked UI

| | Mocked web UI (§2) | HTTP integration (§4) |
| --- | --- | --- |
| Browser / happy-dom | Yes | No |
| `nq serve` routes, headers, SSE/stream | No | Yes |
| Temp Campaign + `FakeAgentFactory` | Optional | Required |
| Live Provider | No | No |

---

## 5. Fixture shape

### 5.1 What primary sources say about "realistic"

They do **not** define Campaign folders, Seed Packs, or midgame transcripts.

- Testing Library: tests should resemble use; query what a player can see/hear ([principles](https://testing-library.com/docs/guiding-principles), [query priority](https://testing-library.com/docs/queries/about/#priority)). Escape-hatch `data-testid` is for dynamic text, not a license to stub the whole world as `foo`.
- OpenTUI's own examples use `"Hello, World!"` and a todo list ([testing](https://opentui.com/docs/core-concepts/testing/)). That is library smoke, not product guidance.
- Bun has no fixture-realism doctrine.

So "realistic" for NQ is a **product** meaning (later grilling). Stacks only constrain *how* you assert: visible names and copy, not CSS class names or snapshot blobs.

### 5.2 Reuse vs invent — what already exists

| Asset | What it is | Fits which tests |
| --- | --- | --- |
| `tests/eval/packs/memory-gym` | Tiny Brinewatch premise; canaries (`CANARY-BELL-7E`, Salt-lung, Tide Choir, Mira Venn, Kell Reed). Pack notes: *not a play-first adventure* | Inspect of planted facts; hygiene-adjacent chrome. Weak as a "fun story" visual |
| `packs/brinewatch` | Mid-size coastal sandbox; 12 dossiers (mira-venn, kell-reed, salt-lamp, brine-well, …) | Inspect index + bodies; long names/wrapping; default "looks like a Campaign" |
| `tests/eval/fixtures/dirty-midgame/` | Overlay *after* `nq new`: missing `## Powers`, token only in transcript, resolved lemon still on quest-log, duplicate Kell dossiers, tripled Tide Choir, sparse beats, planted `transcript.jsonl` | Midgame inspect, transcript tail, rotten memory in the inspect pane. Already applied by `birthDirtyMemoryGym` |
| `tests/eval/fixtures/dirty-long/` + generated ≥40k transcript | Long-session eval | **Not** for mocked UI — too large, eval-only |
| `tests/helpers/campaign.ts` `birthCampaign` | Tiny synthetic pack (weary ranger / haunted marsh) | Control-plane only. Too `foo`-like for surface chrome |

`apply_fixture.ts` already copies overlay files onto a birthed Campaign. Surface tests should call `birthDirtyMemoryGym` / `newCampaign({ packDir: BRINEWATCH_PACK_DIR })`, not duplicate those trees.

### 5.3 What is still missing (small, not new packs)

These are **event scripts and strings**, not new Seed Packs:

| Gap | Shape |
| --- | --- |
| Long GM prose | One Brinewatch-voiced multi-paragraph string to prove wrap/scroll in story regions |
| Hygiene-in-flight | `hygiene_started` / `status: "Memory hygiene…"` / `hygiene_ended` sequence (already emitted by `PlayLoop`; just replay) |
| Fail-turn | `turn_ended { outcome: "fail", reason: "empty_prose" \| "interrupt" \| "busy" }` |
| Empty opening | Fresh `nq new` from brinewatch/`tests/eval/packs/memory-gym` (opening transcript only) — `birthCampaign` is the wrong names |
| Hard-busy | `turn_started` … delayed `turn_ended` while input is attempted |

Do **not** invent a third "UI pack" with fake slugs. Do **not** use `dirty-long` / 40k transcripts as a UI fixture.

---

## 6. Effect testing modules (how they compose)

Effect's documented test services live in the core library, not a separate runner:

| Module | Job | Use in NQ surfaces |
| --- | --- | --- |
| `TestContext.TestContext` | Layer of test services (clock, etc.) | `Effect.provide(TestContext.TestContext)` around surface Effects |
| `TestClock` | `adjust` / `setTime`; clock does not advance alone | Hygiene-interval UI, timeouts, SSE idle — without `sleep(60_000)` |
| `TestConfig` | repeats / retries / samples / shrinks | Property-test knobs; unused unless NQ adds those |
| `TestLive` | Real default services | Opt-in when a test must use wall clock |
| v3 `HttpApp.toWebHandler` | `(Request) => Promise<Response>` without listen | Preferred in-process serve unit test |
| v3 `BunHttpServer.layerTest` | Ephemeral port + injected `HttpClient` | Integration when a real URL is required (streams / WS) |

Official TestClock examples fork the effect, adjust the clock, then join ([docs](https://www.effect.website/docs/v3/testing/testclock)). They use `node:assert` + `Effect.runPromise`, which is runner-agnostic.

`@effect/vitest` (`it.effect`) auto-provides `TestContext` ([community/docs mentions](https://www.effect.solutions/testing)). Adopting it would **split** NQ off `bun test`. Tradeoff: nicer Effect DX vs a second runner and lost Bun DOM/OpenTUI integration. Fact: not required.

Play Loop stays Promise-based (map lock). Effect tests wrap the adapter, not `src/play/loop.ts`.

---

## 7. What not to adopt

| Stack | Why it fails the ticket's constraints |
| --- | --- |
| **Playwright Test / `@playwright/test`** | First-party runner is `npx playwright test` on Node ([intro](https://playwright.dev/docs/intro)). Bun support request [#38095](https://github.com/microsoft/playwright/issues/38095) is **closed as not planned**. Ticket said Playwright only if Bun-official or clearly compatible — it is neither. |
| **`Bun.WebView` as mocked UI** | Official, but a **real** headless WebKit/Chrome ([docs](https://bun.com/docs/runtime/webview)), experimental, needs a Chrome install on Linux, `isTrusted` OS events, screenshots. That is optional later browser smoke, not `bun test` unit/mocked UI. |
| **Heavy browser CI for unit tests** | Same: download browsers, shard, flake on layout. Mocked UI is happy-dom / OpenTUI memory renderer. |
| **jsdom as the default** | Works; Bun and happy-dom document the other default. Extra weight, no Bun guide. |
| **Repo-wide happy-dom preload** | Official Bun snippet, but pollutes Play Loop / OpenTUI / eval files that must not assume `document`. Scope it. |
| **Snapshot-only TUI tests** | Bun snapshots exist; OpenTUI's own tests assert `toContain` / predicates. Full-frame snapshots churn on wrap and chrome copy. |
| **Screenshot / visual-diff as the bar** | `Bun.WebView.screenshot` and Playwright shots test pixels, not story/status/busy. |
| **`@testing-library/react` without React** | Bun's RTL sample is for React apps. DOM Testing Library is the framework-agnostic package. |
| **`@effect/vitest` as the suite runner** | Forks off `bun test`; OpenTUI + happy-dom + existing files all use `bun:test`. |
| **Live Provider in UI tests** | Opposite of `FakeAgentFactory`. Belongs in opt-in memory eval (`eval:memory`), already specified. |
| **UI-only `foo`/`bar` Campaign fixtures** | Contradicts Testing Library's "resemble use" and this repo's Brinewatch/Memory Gym names. |
| **`dirty-long` / 40k-token transcripts as UI fixtures** | Eval-scale; will dominate runtime and drown assertions. |

---

## 8. Suggested dependency cut (facts, not a lock)

Dev-only, when surfaces exist:

```json
{
  "devDependencies": {
    "@happy-dom/global-registrator": "<pin>",
    "@testing-library/dom": "<pin>",
    "@testing-library/user-event": "<pin>"
  }
}
```

Optional: `@testing-library/jest-dom` for matchers. `@opentui/core` (product dep) already exports `@opentui/core/testing` — no extra test package. Effect test modules ship inside `effect`. No Playwright, no jsdom, no `@effect/vitest` required.

---

## 9. Mapping onto existing NQ tests

| Today | Stays | Surfaces add |
| --- | --- | --- |
| `tests/play/*.test.ts` + `FakeAgentFactory` | Control plane | Unchanged |
| `tests/play/tui_events.test.ts` (PassThrough + `createTuiEventWriter`) | Formatter unit tests for the **current** readline TUI | OpenTUI tests replace this *as the surface bar* once `nq play` moves; keep writer tests if the formatter remains |
| `tests/cli/turn_cli.test.ts` (`Bun.spawn` + `NQ_FAKE_AGENT`) | CLI argv / exit | `server.fetch` for `nq serve` |
| `tests/campaign/show.test.ts` | Inspect reader | Web inspect pane consumes `showCampaign`, does not reimplement it |
| `tests/eval/*` + live `eval:memory` | Memory quality | Not a UI bar |

---

## Bibliography

- [Bun — Test runner](https://bun.com/docs/test)
- [Bun — DOM testing](https://bun.com/docs/test/dom)
- [Bun — Write browser DOM tests with happy-dom](https://bun.com/docs/guides/test/happy-dom)
- [Bun — `Bun.serve` / `server.fetch`](https://bun.com/docs/runtime/http/server)
- [Bun — `Bun.WebView` (experimental)](https://bun.com/docs/runtime/webview)
- [happy-dom — Getting started](https://github.com/capricorn86/happy-dom/wiki/Getting-started)
- [happy-dom — Setup as Test Environment](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment)
- [happy-dom — Global Registrator](https://github.com/capricorn86/happy-dom/wiki/Global-Registrator)
- [jsdom README](https://github.com/jsdom/jsdom)
- [Testing Library — DOM intro](https://testing-library.com/docs/dom-testing-library/intro/)
- [Testing Library — Guiding Principles](https://testing-library.com/docs/guiding-principles)
- [Testing Library — Queries / priority](https://testing-library.com/docs/queries/about/)
- [Testing Library — user-event](https://testing-library.com/docs/user-event/intro)
- [OpenTUI — Testing](https://opentui.com/docs/core-concepts/testing/)
- [OpenTUI — Testing TUI Applications (Mintlify)](https://anomalyco-opentui.mintlify.app/advanced/testing)
- [OpenTUI — `test-renderer.ts`](https://github.com/anomalyco/opentui/blob/main/packages/core/src/testing/test-renderer.ts)
- [Effect — TestClock (v3)](https://www.effect.website/docs/v3/testing/testclock)
- [Effect — TestContext API](https://www.effect.website/docs/v3/api/effect/TestContext)
- [Effect — HttpServer testing (v4 `makeTestClient`, unused successor)](https://www.effect.website/docs/v4/api/effect/unstable/http/HttpServer)
- [NQ — Effect + Bun HTTP envelope](effect-bun-http-envelope.md)
- [Playwright — Intro](https://playwright.dev/docs/intro)
- [Playwright — Bun support #38095](https://github.com/microsoft/playwright/issues/38095)
