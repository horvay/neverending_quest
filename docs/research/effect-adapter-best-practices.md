# Effect practices that constrain the Play Loop adapter

Research for [Effect adapter over Play Loop](../../.scratch/nq-player-surfaces/issues/10-effect-adapter-over-play-loop.md).  
Inspected 2026-08-13. Primary sources first; community patterns only where they rest on those APIs.

Does **not** decide the adapter (grilling ticket still open). Records what official Effect v3 docs say we should do when wrapping a Promise `PlayLoop`.

---

## Summary

| Practice | Official source | Meaning for NQ |
| --- | --- | --- |
| Declare a **service** (`Context.Tag` / `Effect.Service`); methods’ `R` stays `never` | [Managing Services](https://www.effect.website/docs/v3/requirements-management/services/) | One `PlaySession` tag. Don’t put `HttpServer` or config in `submit`’s Requirements. Layers construct the service. |
| Wrap Promise APIs with **`Effect.tryPromise` / `Effect.promise`** | [Creating Effects](https://www.effect.website/docs/v3/getting-started/creating-effects/); [EffectPatterns: tryPromise](https://github.com/PaulJPhilp/EffectPatterns/blob/main/content/published/patterns/core-concepts/wrap-asynchronous-computations.mdx) | `PlayLoop.open` / `turn` / `close` / `interrupt` go through these. Do not `.then`/`.catch` inside `Effect.sync`. |
| Long-lived resources via **`Effect.acquireRelease` + `Scope`** | [Scope](https://www.effect.website/docs/v3/resource-management/scope/) | Acquire = `loop.open()`, release = `loop.close()`. Release always runs when the Scope closes (success, fail, or interrupt). Acquisition is uninterruptible. |
| **Expected errors** are tagged and short-circuit; don’t fail the Effect for domain “Turn failed” | [Expected Errors](https://www.effect.website/docs/v3/error-management/expected-errors/) | `MissingSeedError` / campaign-missing → `Effect.fail` (tagged). `turn_ended` fail / hygiene / busy stay **`PlayEvent`s**. `submit` succeeding means the loop accepted the call. |
| Multi-subscriber events: **`PubSub` + `Stream.fromPubSub`** | [PubSub](https://www.effect.website/docs/v3/concurrency/pubsub/); [Creating Streams](https://www.effect.website/docs/v3/stream/creating/) | Several `GET /api/events` clients must all see the same `PlayEvent`. PubSub broadcasts; Queue does not. Prefer **sliding** or **dropping** (unbounded can grow forever; bounded back-pressures the GM). |
| `runPromise` / `runFork` only at the **edge** | Effect vs Promise; EffectPatterns “end of the world” | OpenTUI: `runPromise`/`runFork` around acquire + event fold. Serve: `BunRuntime.runMain(Layer.launch(…))`. No `runPromise` inside the adapter. |
| Test with a **Layer**, same service tag | Managing Services; [effect.solutions Services & Layers](https://www.effect.solutions/services-and-layers) | Inject `FakeAgentFactory` via a test Layer. Do not invent a second Effect-only fake. Fresh layer per test so state does not leak. |

---

## 1. Service, not a bag of functions

[Managing Services](https://www.effect.website/docs/v3/requirements-management/services/) is the DI law: a **tag** + a **type of operations**. Yield the tag; provide an implementation with `provideService` / a `Layer`.

**Do not leak construction deps into method types.** The docs call out a Logger whose `log` requires `Config` in `R` as the anti-pattern. Put `Config` on the Layer that *builds* Logger.

For NQ: `PlaySession` methods (`submit`, `interrupt`, `events`) should not require `HttpServer` or `AgentSessionFactory` in `R`. The Layer that constructs the live session takes the factory and Campaign path.

`Effect.Service` (v3.9+) bundles Tag + default Layer. Community write-ups ([effect.solutions](https://www.effect.solutions/services-and-layers), EffectPatterns) prefer it when there is an obvious default. Either Tag or `Effect.Service` is fine; pick one and stick to it.

---

## 2. Wrapping the existing Promise `PlayLoop`

Official constructors ([Creating Effects](https://www.effect.website/docs/v3/getting-started/creating-effects/)):

| API | Use |
| --- | --- |
| `Effect.tryPromise({ try, catch })` | Promise that may reject → error channel |
| `Effect.promise` | Promise you treat as infallible (rejection becomes a defect) |
| `Effect.async` | Callback APIs (`onEvent`) |

EffectPatterns’ wrap-asynchronous-computations guideline: **`tryPromise` is the standard bridge.** Anti-pattern: manual `.then`/`.catch` inside `Effect.sync`.

The Scope docs’ resource example is almost our adapter: acquire a Promise resource, `Effect.tryPromise` on open, `Effect.promise` on `close()`, wrap in `acquireRelease`.

---

## 3. Lifetime = Scope

[Scope](https://www.effect.website/docs/v3/resource-management/scope/):

- `acquireRelease(acquire, release)` — acquire is **uninterruptible**; once acquired, **release always runs** when the Scope closes (success, fail, or interrupt).
- Finalizers run in **reverse** add order.
- `Effect.scoped` creates a Scope, runs the effect, closes the Scope.
- Layers that hold resources are scoped (`Layer.scoped` / `Layer.launch`).

Tweag’s Effect intro ([2024-11-07](https://tweag.io/blog/2024-11-07-typescript-effect/)) repeats the same: `HttpClient` needs a Scope so interrupt aborts in-flight requests.

For NQ: one Scope owns one `PlayLoop`. Serve’s `Layer.launch` is that Scope. OpenTUI opens one Scope for the renderer lifetime. Do not also hang `process.on("SIGINT")` that calls `loop.close()` behind Effect’s back — the Scope finalizer is the close path. Surfaces still decide *when* to close the Scope (Idle quit vs serve Ctrl+C).

---

## 4. Error channel vs Play Events

[Expected Errors](https://www.effect.website/docs/v3/error-management/expected-errors/):

- Failures in `E` are **expected**, tagged (`Data.TaggedError`), and **short-circuit** the rest of that Effect.
- Defects (`die`) are unexpected.
- `catchTag` / `catchTags` need a `_tag`.

If `submit` `Effect.fail`s on Turn FAIL, HTTP/OpenTUI short-circuit as if the process is broken. The Play Loop already models Turn FAIL as a `PlayEvent`. That matches “don’t put domain outcomes that the UI must keep running after into `E`.”

Put in `E`: cannot open (missing seed, not a Campaign).  
Keep as events: busy, empty prose, interrupt, hygiene fail, agent error.

Wrap existing `MissingSeedError` as a tagged error (or map it in `tryPromise`’s `catch`) so `catchTag` works.

---

## 5. Fan-out events: PubSub, not a single Stream.async

[Creating Streams](https://www.effect.website/docs/v3/stream/creating/) lists `Stream.async` (one callback) and **`Stream.fromPubSub` / `Stream.fromQueue`**.

[PubSub](https://www.effect.website/docs/v3/concurrency/pubsub/): every published message goes to **all current subscribers**. Queue gives each value to **one** consumer. We already allow several browsers on `GET /api/events`. That is PubSub.

Docs also: a subscriber only sees messages published **while subscribed** (snapshot line is still the HTTP handler’s job, then subscribe). Prefer bounded / dropping / sliding over unbounded (“can grow indefinitely”).

For `prose_delta` volume: **sliding** (keep newest, never block `PlayLoop`) or **dropping**. Bounded back-pressure would stall `turn()` if a tab is stuck — bad for live-through writes.

`PlayLoop.onEvent` → `PubSub.publish`. Each surface / HTTP stream is `Stream.fromPubSub`. That is still **one** event path, not a second bus.

---

## 6. Edges only

`Effect.runPromise` / `runFork` / `BunRuntime.runMain` convert Effect → the host. Official “Effect vs Promise” framing: Effect is the program; the runtime is the edge.

OpenTUI has no Effect interop. Practice: one `runFork`/`runPromise` for “open session + fold events into the Play Kernel + run the renderer until quit,” not `runPromise` per keystroke if it can be `submit` as an Effect on that same runtime.

---

## Sources

- [Managing Services](https://www.effect.website/docs/v3/requirements-management/services/)
- [Managing Layers](https://www.effect.website/docs/v3/requirements-management/layers)
- [Scope / acquireRelease](https://www.effect.website/docs/v3/resource-management/scope/)
- [Creating Effects](https://www.effect.website/docs/v3/getting-started/creating-effects/)
- [Expected Errors](https://www.effect.website/docs/v3/error-management/expected-errors/)
- [Creating Streams](https://www.effect.website/docs/v3/stream/creating/)
- [PubSub](https://www.effect.website/docs/v3/concurrency/pubsub/)
- [Effect vs Promise](https://www.effect.website/docs/v3/additional-resources/effect-vs-promise)
- [EffectPatterns — tryPromise](https://github.com/PaulJPhilp/EffectPatterns/blob/main/content/published/patterns/core-concepts/wrap-asynchronous-computations.mdx) (community, cites official constructors)
- [Tweag — Exploring Effect](https://tweag.io/blog/2024-11-07-typescript-effect/) (secondary; Scope + Stream.async)
- [effect.solutions — Services & Layers](https://www.effect.solutions/services-and-layers) (secondary; don’t leak R on methods; fresh test layers)
