# OpenTUI + Bun and testability

Research note for ticket [OpenTUI + Bun and testability](../../.scratch/nq-player-surfaces/issues/02-opentui-bun-and-testability.md).  
Primary sources: [opentui.com docs](https://opentui.com/docs/getting-started) (inspected 2026-08-13), [anomalyco/opentui](https://github.com/anomalyco/opentui) README / [Development Guide](https://github.com/anomalyco/opentui/blob/main/packages/core/docs/development.md) / types / CI, published `@opentui/core@0.5.2` (npm + GitHub `packages/core`). React/Solid bindings reviewed only for whether they change the cut.

Does **not** decide the `nq play` chrome contract (ticket [OpenTUI play chrome](../../.scratch/nq-player-surfaces/issues/08-opentui-play-chrome.md)).

## Summary (Player Surface on Bun)

| Topic | Recommendation | Source anchor |
| --- | --- | --- |
| **Can it be `nq play`?** | **Yes** on Bun. Imperative `@opentui/core` covers story scroll, status line, single-line input, and a testable render loop. | Getting started; ScrollBox / Input / Text docs |
| **Dependency cut** | **Direct dep: `@opentui/core@0.5.2` only** (pin exact). Do **not** take `@opentui/react` or `@opentui/solid` for v1. Optional later: `@opentui/keymap` if chrome wants a command engine. | README package list; entrypoints; Effect-as-surface-layer lock |
| **Runtime** | **Bun-first.** `engines.bun: ">=1.3.0"`. Importing packages needs no FFI; **`createCliRenderer()` does.** Node renderer path is Node **26.4.0** + `--experimental-ffi` — not NQ’s play runtime. | Getting started “Runtime support”; `package.json` engines |
| **Native / CI** | Published optional native packages (`@opentui/core-<os>-<arch>` lockstep `0.5.2`). **Zig is not required** to install or test a consumer. Tests still **dlopen the prebuilt** — CI must get the host optional dep. | `optionalDependencies`; `runtime-assets.bun.ts`; testing docs |
| **Headless tests** | **Official harness exists:** `@opentui/core/testing` `createTestRenderer()`. Real native `CliRenderer`, **memory destination**, no TTY. **Not** a JS-only mock and **not** a draw-call recorder that skips Zig. | [Testing](https://opentui.com/docs/core-concepts/testing/); `src/testing/test-renderer.ts` |
| **Effect interop** | **None official.** Docs mention Effect.ts only as a reason OpenTUI does **not** auto-`destroy()` on `process.exit`. OpenTUI owns the frame loop; NQ Effect owns surface lifecycle (`acquire`/`destroy`). | [Lifecycle](https://opentui.com/docs/core-concepts/lifecycle/) |
| **What to pin** | `@opentui/core@0.5.2` exact (lockstep with native optional packages). Bump NQ `engines.bun` to **≥1.3.0** (OMP already wants ≥1.3.14). | npm `0.5.2`; core `engines` |

---

## 1. Package cut for a Bun CLI

Monorepo packages ([README](https://github.com/anomalyco/opentui/blob/main/README.md)):

| Package | Role | NQ `nq play` |
| --- | --- | --- |
| `@opentui/core` | Zig bindings, `createCliRenderer`, renderables, constructs, input | **Direct dependency** |
| `@opentui/core/testing` | Test renderer, mock keys/mouse, clocks, `TestRecorder` | **Test-only import** (same package) |
| `@opentui/react` | React reconciler + `createRoot` / `testRender` | **No** |
| `@opentui/solid` | Solid reconciler + Bun preload/plugin | **No** |
| `@opentui/keymap` | Host-agnostic command/keybinding engine | Optional later |
| `@opentui/ssh`, `@opentui/three`, `@opentui/qrcode` | SSH serve, WebGPU, QR | Out of scope |

**Why not React/Solid for v1**

- They wrap the **same** `CliRenderer` and the same primitives (`<input>`, `<scrollbox>`, `<text>`). They do not add a widget NQ lacks in core.
- Destination lock: Effect is the **new surface layer only**. A JSX reconciler would be a second UI runtime next to Effect.
- Solid’s `preload` / `bun-plugin` / runtime-plugin entries are Bun-specific extras NQ does not need for a small play chrome.
- React/Solid test helpers (`@opentui/react/test-utils`, Solid `testRender`) only wrap `createTestRenderer()` with `act()` / Solid mount. Core testing is enough.

**API style inside core:** constructs (`Box`, `Text`, `Input`, `ScrollBox`) or `*Renderable` classes. Constructs are VNodes instantiated on `root.add` ([Constructs](https://opentui.com/docs/core-concepts/constructs)). Either is fine; chrome grilling picks the composition.

**Install shape (conceptual):**

```json
{
  "dependencies": {
    "@opentui/core": "0.5.2"
  }
}
```

Pin **exact** `0.5.2` so TypeScript and the eight optional native packages stay lockstep.

---

## 2. Runtime: Bun-first, Node FFI, Zig in CI

### 2.1 Bun is the documented app runtime

- Getting started: examples use `bun init`, `bun add @opentui/core`, `bun index.ts`.
- Published `engines`: `"bun": ">=1.3.0"`.
- Upstream CI installs **Bun 1.3.14** ([`build-core.yml`](https://github.com/anomalyco/opentui/blob/main/.github/workflows/build-core.yml)).
- NQ today: `"bun": ">=1.1.0"` and `bun test`. OMP embed already documents `bun >= 1.3.14`. Adopting OpenTUI means **raising NQ’s Bun floor** to at least 1.3.0 (prefer 1.3.14 to match both vendors).

### 2.2 Import ≠ renderer

From [Getting started — Runtime support](https://opentui.com/docs/getting-started/#runtime-support):

- Importing `@opentui/core` / `@opentui/keymap` **does not** require native FFI (Node can load those modules without `--experimental-ffi`).
- **Creating a native renderer** (`createCliRenderer()` or any API that loads the Zig lib) **does** require FFI.
- Node renderer path: **Node.js 26.4.0** + `--experimental-ffi` (+ `--allow-ffi` if using the permission model). OpenTUI does not install Node.

NQ’s `nq play` is a Bun CLI. Do **not** target the experimental Node FFI path for play or for CI.

Published exports split Bun/Node entry files (`index.bun.js` vs `index.node.js`). `@opentui/core/testing` is published for `bun` and generic `import` (not a Node-specific test entry).

### 2.3 Native Zig core — consumer vs upstream

**Consuming `@opentui/core` from npm (NQ’s case):**

- `optionalDependencies` ship prebuilt libs at the **same version**:
  - `@opentui/core-darwin-x64` / `darwin-arm64`
  - `@opentui/core-linux-x64` / `linux-arm64`
  - `@opentui/core-linux-x64-musl` / `linux-arm64-musl`
  - `@opentui/core-win32-x64` / `win32-arm64`
- Bun resolve (`packages/core/src/platform/runtime-assets.bun.ts`): `import("@opentui/core-<platform>")` then `dlopen`. Linux default is **glibc**; set `OPENTUI_LIBC=musl` **before import** for Alpine-class CI.
- Missing/unsupported platform throws: `OpenTUI is not supported on the current platform: …` (`zig.ts` / `resolveNativeLibraryPath`).
- **Zig compiler is not needed** at `bun install` or `bun test` if the optional package for the host installs.

**Building OpenTUI from source (not NQ’s job):** Zig required; upstream CI uses **Zig 0.16.0** and `bun run build:native`. README “must have Zig” applies to the monorepo, not to the published tarball.

**CI implications for NQ**

| Need | Fact |
| --- | --- |
| TTY / `script` / `expect` | **Not required** for widget tests |
| Zig toolchain | **Not required** if optional natives install |
| Host native package | **Required** — `createTestRenderer` still constructs a real `CliRenderer` and loads Zig |
| Alpine / musl runner | `OPENTUI_LIBC=musl` before any `@opentui/core` import |
| `OTUI_NO_NATIVE_RENDER` | Skips native **frame** paint; loop still runs; **not** a test harness ([env vars](https://opentui.com/docs/reference/env-vars)) |

Standalone `bun build --compile` can embed the native lib ([Standalone executables](https://opentui.com/docs/reference/standalone-executables)). Irrelevant until packaging is in scope.

---

## 3. Widget primitives (chrome mapping, not chrome contract)

These are the official primitives that **can** realize the locked play chrome (scrolling story, minimal status, single-line input, hard-busy while Turning). Layout/copy/keys stay on ticket 08.

### 3.1 Scrolling story

[`ScrollBox`](https://opentui.com/docs/components/scrollbox) / `ScrollBoxRenderable`:

- Vertical scroll default (`scrollY: true`, `scrollX: false`).
- **`stickyScroll: true` + `stickyStart: "bottom"`** — documented as the chat/log pattern; sticky pauses when the user scrolls away and resumes at the edge.
- `viewportCulling` default **true** (off-screen children skip `renderBefore`/`renderAfter`).
- `scrollBy` / `scrollTo` / `scrollChildIntoView`; `scrollTop` get/set.
- When **focused**: arrows / page / home / end scroll.

Column flex (`Box` `flexDirection: "column"`, story `flexGrow: 1`) is the documented layout pattern for header / body / footer ([Box](https://opentui.com/docs/components/box)).

**Not** the play model: `screenMode: "split-footer"` + `writeToScrollback` / `ScrollbackSurface` — that pins a footer and publishes ANSI into **terminal scrollback**. Full-screen `nq play` should stay on default `"alternate-screen"` unless chrome grilling says otherwise.

### 3.2 Status line

No dedicated StatusBar widget. Official **status-bar example** is a 1-row `Box` + `Text` ([Text](https://opentui.com/docs/components/text#example-status-bar)):

```ts
Box(
  {
    position: "absolute",
    bottom: 0,
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  Text({ content: "…" }),
  Text({ content: "…" }),
)
```

`Box` also has `title` / `bottomTitle` on the border. Editor `traits.status` is a **string hint** for a host footer ([Textarea traits](https://opentui.com/docs/components/textarea#traits)), not a widget.

### 3.3 Single-line input

[`Input`](https://opentui.com/docs/components/input) / `InputRenderable`:

- Height forced to **1**; newlines stripped; Enter **submits** (`InputRenderableEvents.ENTER`) unless `value.length < minLength`.
- `CHANGE` on blur or Enter if the value changed since focus; `INPUT` on edits.
- `focus()` / `blur()`; `value` get/set; `maxLength` default 1000.
- Construct `Input({ placeholder, width })` queues `focus()` until instantiated.

`TextareaRenderable` is multi-line (Enter inserts newline unless rebound). Not the locked single-line prompt.

### 3.4 Hard-busy (ignore input while Turning)

**No first-class “busy mode” or `enabled: false` on Input.** Official tools NQ can compose:

| Primitive | What it does | Fit for Turning |
| --- | --- | --- |
| `input.blur()` + `input.focusable = false` | Stops key routing to the field (`Renderable.focus` no-ops if not focusable) | **Primary** — input cannot accept a second Turn |
| `renderer.prependInputHandler(seq => true)` | Runs **before** built-ins; `true` consumes the sequence ([Renderer](https://opentui.com/docs/core-concepts/renderer#input-handling)) | Host-level swallow (keep Ctrl+C if Play Loop needs FAIL) |
| `KeyEvent.preventDefault()` / `stopPropagation()` | Global `keyInput` handlers run before focused renderables (`InternalKeyHandler`) | Same, at parsed-key level |
| Editor `traits.suspend` | **Hint** to dim host chrome | Visual only — **not** an input lock |
| `renderer.suspend()` | Disables mouse, input, **and raw mode** | **Too heavy** for Turning |

NQ owns the policy (which keys still work: quit, scroll story, Ctrl+C → FAIL). OpenTUI only supplies focus + handler precedence.

---

## 4. Streaming `prose_delta` into a scroll region

Official incremental-text paths:

1. **`TextRenderable.content` setter** — replaces the styled buffer and `requestRender()`s (`Text.ts` `set content` → `updateTextBuffer` → `updateTextInfo`). Automatic render-on-tree-change is the default loop ([Renderer](https://opentui.com/docs/core-concepts/renderer#automatic-mode-default)). Append = `text.content = previous + delta` (or keep a string and assign).
2. **`TextBuffer.append(text)`** — native chunk append (`text-buffer.ts`). Used under Code/Markdown; **not** a documented method on `Text` / `TextRenderable`. Prefer the `content` setter unless NQ drops to the buffer.
3. **`MarkdownRenderable` `streaming: true`** — documented incremental parse; `content += chunk`; set `streaming = false` to finalize ([Markdown](https://opentui.com/docs/components/markdown#streaming-updates)). Optional; chrome ticket decides raw vs markdown.
4. **`ScrollBox` sticky bottom** — keep the viewport on new story rows as height grows.
5. **`ScrollbackSurface` / `writeToScrollback`** — split-footer only; throws otherwise. Not the alternate-screen play tree.

`requestRender()` is implicit on content/layout change. `renderer.start()` / `requestLive()` are for continuous FPS / animation, not for token appends.

---

## 5. Headless / mocked renderer

**There is an official test harness.** It is **not** a JS-only fake renderer and **not** a “record draw calls, skip native” path.

### 5.1 `@opentui/core/testing` — `createTestRenderer`

Documented at [Testing](https://opentui.com/docs/core-concepts/testing/); implementation `packages/core/src/testing/test-renderer.ts`.

- Constructs `new CliRenderer(...)` **directly** (skips `createCliRenderer()` / `setupTerminal()` / host raw mode).
- Default `bufferedOutput: "memory"` — native frames stay in the in-memory buffer; **does not write the host terminal**.
- Defaults: `screenMode: "main-screen"`, `consoleMode: "disabled"`, `externalOutputMode: "passthrough"`.
- Still **creates the native Zig renderer** and applies the same `useThread` defaults as production.
- Caller **must** `setup.renderer.destroy()` in `finally`.

Returned setup (docs + types):

| Member | Use |
| --- | --- |
| `renderer` | Real `CliRenderer` |
| `mockInput` | `createMockKeys()` — `typeText`, `pressKey`, `pressEnter`, … |
| `mockMouse` | SGR mouse driver |
| `renderOnce()` | One loop pass |
| `flush` / `waitFor` / `waitForFrame` / `waitForVisualIdle` | Async settle (default 20 passes) |
| `captureCharFrame()` | Current character buffer as text (snapshots) |
| `captureSpans()` | Styled spans + cursor |
| `resize(w, h)` | Test resize path |
| `getNativeStats()` | Native render stats |

Also exported: `ManualClock` (inject via `CliRendererConfig.clock`), `TestRecorder` (listen to `frame`, keep char buffers / optional fg/bg/attributes), `createSpy`, `createTerminalCapabilities` / `setRendererCapabilities`, `MockTreeSitterClient`.

`TestRecorder` records **after native frames**, not a separate draw-call log.

### 5.2 What does **not** exist

- No official **pure-TypeScript mock renderer** that avoids the Zig `.so`/`.dylib`.
- No documented **record-draw-calls-without-native** API.
- `OTUI_NO_NATIVE_RENDER` is a debug skip of native paint, not a harness.
- Custom `stdin`/`stdout` on `createCliRenderer()` is for SSH/pty transports, not the default unit-test path.

### 5.3 NQ test split (research only)

| Layer | How |
| --- | --- |
| Play Loop / events | Existing `bun test` + `FakeAgentFactory` (no OpenTUI) |
| Widget / chrome | `createTestRenderer` + `captureCharFrame` / `mockInput` |
| Effect surface | Treat renderer as `acquire`/`release`; `ManualClock` if timers matter |

React `testRender` / Solid `testRender` only matter if those bindings are adopted.

---

## 6. Effect interop

**No `@opentui/effect` (or similar).** No documented bridge between the Effect runtime and `CliRenderer`.

The only official mention is [Lifecycle](https://opentui.com/docs/core-concepts/lifecycle/): OpenTUI **does not** auto-clean on `process.exit` so apps — **“effect systems, like Effect.ts”** — can own shutdown. That is a cleanup footnote, not an interop API.

**Who owns what**

| Concern | Owner |
| --- | --- |
| Frame scheduling (`requestRender`, optional `start`/`stop`/`requestLive`, `targetFps`/`maxFps`) | **OpenTUI `CliRenderer`** |
| Play Loop (Promise today; thin Effect adapter later) | **NQ** — unchanged by this ticket |
| Surface lifecycle (create renderer, subscribe to Play Events, `destroy()` on quit/interrupt) | **NQ Effect layer** — `try`/`finally` or Effect `acquireRelease` |
| Signal / Ctrl+C | OpenTUI defaults (`exitOnCtrlC: true`, several `exitSignals`); NQ should **narrow or disable** these so Turning Ctrl+C → FAIL → Idle is NQ policy, not process death |

Do **not** drive OpenTUI frames from Effect fibers (no `Effect.repeat` paint loop). Push Play Events into renderables; let the renderer schedule. `renderer.idle()` / `getSchedulerState()` exist for tests and custom output.

`exitSignals: []` + `exitOnCtrlC: false` is the documented pattern when a host owns many sessions or custom shutdown ([Lifecycle](https://opentui.com/docs/core-concepts/lifecycle/), [Renderer custom streams](https://opentui.com/docs/core-concepts/renderer#custom-streams)).

---

## 7. Version / maturity

| Item | Fact |
| --- | --- |
| Current publish | **`0.5.2`** (`@opentui/core`, `@opentui/react`, `@opentui/solid`, all `core-*` natives) |
| Semver | **0.x** — pin exact; upgrade deliberately |
| Production claim | Powers [OpenCode](https://opencode.ai) (README / getting started) |
| Types | Published `index.d.ts` / `testing.d.ts`; monorepo sources are TypeScript (`src/index.ts` as `types`) |
| License | MIT |
| Upstream CI | Bun 1.3.14, Node 26.4.0 (Node test job on Linux only), Zig 0.16.0 for **their** native build |
| Velocity | Active monorepo (`packages/core` scripts, large FFI surface in `zig.ts`) |

**Pin:** `@opentui/core@0.5.2`. Do not mix core and native optional package versions.

Maturity caveats for NQ: 0.x API can move; native optional install must succeed on every CI OS; `destroy()` is mandatory or the tty (and test process) leaks raw mode / natives.

---

## 8. Concrete recommendation for NQ

1. **Depend on** `@opentui/core@0.5.2` (exact). Import `@opentui/core/testing` only in tests.
2. **Run `nq play` on Bun ≥ 1.3.0** (prefer 1.3.14). Do not use Node FFI for play.
3. **CI:** `bun install` + `bun test` on a glibc Linux (or Darwin) runner so `@opentui/core-linux-x64` (etc.) installs. No Zig. No TTY. Always `destroy()` test renderers.
4. **Chrome primitives (for ticket 08, not decided here):** `ScrollBox` (sticky bottom) + `Text`/`MarkdownRenderable` for story; 1-row `Box`+`Text` for status; `InputRenderable` for the prompt; NQ-owned busy via `blur`/`focusable` + optional `prependInputHandler`.
5. **Stream** `prose_delta` by assigning `Text`/`Markdown` `content` (markdown `streaming: true` if chrome chooses markdown). Sticky scroll keeps the tail visible.
6. **Effect:** no library help. Acquire renderer in the surface layer; never let OpenTUI’s default Ctrl+C/`exitSignals` bypass Play Loop FAIL/Idle.
7. **Do not** take React/Solid unless a later ticket reopens the UI-runtime choice.

Does **not** decide widget layout, live vs `turn_ended` printing, markdown vs raw prose, or native-load fallback (ticket 08).

---

## Sources

- [Getting started](https://opentui.com/docs/getting-started) — install, Bun examples, runtime/FFI split
- [Renderer](https://opentui.com/docs/core-concepts/renderer) — `createCliRenderer`, loop, screen modes, scrollback, input handlers, `clock`
- [Testing](https://opentui.com/docs/core-concepts/testing) — `createTestRenderer`, mocks, `TestRecorder`, `ManualClock`
- [Package entrypoints](https://opentui.com/docs/reference/package-entrypoints) — `@opentui/core` / `testing` / React `test-utils` / Solid
- [Lifecycle](https://opentui.com/docs/core-concepts/lifecycle) — `destroy()`, signals, Effect.ts mention
- [Environment variables](https://opentui.com/docs/reference/env-vars) — `OTUI_NO_NATIVE_RENDER`, `OPENTUI_LIBC`, `OTUI_ASSET_ROOT`
- [Standalone executables](https://opentui.com/docs/reference/standalone-executables) — Bun compile vs Node SEA
- [Keyboard](https://opentui.com/docs/core-concepts/keyboard) — `keyInput`, focus routing
- Components: [Text](https://opentui.com/docs/components/text), [Box](https://opentui.com/docs/components/box), [Input](https://opentui.com/docs/components/input), [ScrollBox](https://opentui.com/docs/components/scrollbox), [Textarea](https://opentui.com/docs/components/textarea), [Markdown](https://opentui.com/docs/components/markdown)
- [Constructs](https://opentui.com/docs/core-concepts/constructs)
- Bindings: [React](https://opentui.com/docs/bindings/react), [Solid](https://opentui.com/docs/bindings/solid) — reviewed; do not change the cut
- GitHub [README](https://github.com/anomalyco/opentui/blob/main/README.md), [Development Guide](https://github.com/anomalyco/opentui/blob/main/packages/core/docs/development.md), [`build-core.yml`](https://github.com/anomalyco/opentui/blob/main/.github/workflows/build-core.yml)
- Source: `packages/core/package.json` (v0.5.2, engines, optionalDependencies, exports); `src/testing.ts` / `src/testing/test-renderer.ts`; `src/platform/runtime-assets.bun.ts`; `src/zig.ts` (`dlopen`); `src/lib/KeyHandler.ts`; `src/Renderable.ts` (`focusable`/`focus`/`blur`); `src/renderables/Input.ts`; `src/renderables/Text.ts`; `src/text-buffer.ts` (`append`)
- npm: `@opentui/core@0.5.2`, `@opentui/react@0.5.2`, `@opentui/solid@0.5.2` (2026-08-13)
