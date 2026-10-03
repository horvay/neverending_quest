# Effect + Bun HTTP envelope

Research note for ticket [Effect + Bun HTTP envelope](../../.scratch/nq-player-surfaces/issues/01-effect-bun-http-envelope.md).  
Primary sources, inspected 2026-08-13:

- [effect.website v3 platform introduction](https://www.effect.website/docs/v3/platform/introduction)
- [`@effect/platform` README](https://raw.githubusercontent.com/Effect-TS/effect/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform/README.md) (commit `bd20125`, v3 line)
- [`@effect/platform-bun` README](https://raw.githubusercontent.com/Effect-TS/effect/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-bun/README.md) and [`src/BunHttpServer.ts`](https://raw.githubusercontent.com/Effect-TS/effect/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-bun/src/BunHttpServer.ts) / [`internal/httpServer.ts`](https://raw.githubusercontent.com/Effect-TS/effect/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-bun/src/internal/httpServer.ts)
- API refs: [platform](https://www.effect.website/docs/v3/api/platform), [platform-bun](https://www.effect.website/docs/v3/api/platform-bun), [HttpServer](https://www.effect.website/docs/v3/api/platform/HttpServer), [HttpServerResponse](https://www.effect.website/docs/v3/api/platform/HttpServerResponse), [BunHttpServer](https://www.effect.website/docs/v3/api/platform-bun/BunHttpServer)
- Official HTTP tests: [`packages/platform-node/test/HttpServer.test.ts`](https://raw.githubusercontent.com/Effect-TS/effect/bd20125fb9b8ce42f814ba738513daaf83ce723d/packages/platform-node/test/HttpServer.test.ts)
- npm latest (v3 line): `effect@3.22.1`, `@effect/platform@0.97.1`, `@effect/platform-bun@0.91.2`
- Effect v4 RC: [Effect-TS/effect README on `main`](https://github.com/Effect-TS/effect); [v4 effect API](https://www.effect.website/docs/v4/api/effect)

Does **not** pick SSE vs WebSocket (later [Web transport and serve API](../../.scratch/nq-player-surfaces/issues/05-web-transport-and-serve-api.md)) or the Play Loop adapter shape (later [Effect adapter over Play Loop](../../.scratch/nq-player-surfaces/issues/10-effect-adapter-over-play-loop.md)). Records only what the platform already implements.

---

## Summary (`nq serve` envelope)

| Topic | Fact | Source |
| --- | --- | --- |
| **Pin** | **Effect 3.22.1 + `@effect/platform` 0.97.1 + `@effect/platform-bun` 0.91.2** (lockstep). Do **not** take Effect 4 RC. | npm latest; v3 docs; `main` is v4 RC |
| **HTTP stability** | Http Server / Client / API / Socket are **Unstable** even on v3. Path / FileSystem / Terminal / Runtime are Stable. | v3 platform introduction |
| **Direct deps** | `effect`, `@effect/platform`, `@effect/platform-bun`. Transitive: `@effect/platform-node-shared`, `find-my-way-ts`, `multipasta`, `msgpackr`. | published `package.json`s |
| **Not required for `nq serve`** | `@effect/cluster`, `@effect/rpc`, `@effect/sql` (listed peers, unused unless Cluster); `@effect/platform-node`; `@effect/vitest`; HttpApi / Swagger. | platform-bun peers; README hello world |
| **Listen** | `HttpRouter` → `HttpServer.serve()` → `BunHttpServer.layer({ port, hostname })` → `BunRuntime.runMain(Layer.launch(…))`. Pass **`hostname: "127.0.0.1"`** for loopback-only. | platform README Bun example; `ServeOptions` |
| **Incremental events** | First-class **byte stream** (`HttpServerResponse.stream`) and **WebSocket upgrade** (`HttpServerRequest.upgrade` → `Socket`). **No v3 SSE encoder.** v4 adds `effect/unstable/encoding/Sse`. | README streaming; Bun `makeResponse`; v4 API |
| **Cancel → interrupt** | `Request.signal` abort interrupts the request fiber with `HttpServerError.clientAbortFiberId` → **HTTP 499**. Route handlers default interruptible. | Bun `internal/httpServer.ts`; official “client abort” test |
| **Official tests** | **No `TestHttpClient` type.** `BunHttpServer.layerTest` / `NodeHttpServer.layerTest` bind **`port: 0`** (real ephemeral listen) and inject an `HttpClient` with the server URL prepended. In-process alternative: `HttpApp.toWebHandler`. | `BunHttpServer.layerTest`; `HttpServer.layerTestClient`; `HttpApp.ts` |

---

## 1. Package cut

### 1.1 What to install

v3 platform is a **write-once, provide-runtime** split ([introduction](https://www.effect.website/docs/v3/platform/introduction)):

| Package | Role for `nq serve` |
| --- | --- |
| `effect` | Core: `Effect`, `Layer`, `Stream`, `Fiber`, `Schema`. Peer of both platform packages (`^3.22.1`). |
| `@effect/platform` | Abstract `HttpServer`, `HttpRouter`, `HttpServerResponse`, `HttpClient`, `Socket`, `HttpApp`. Peer: `effect` only. |
| `@effect/platform-bun` | `BunHttpServer`, `BunRuntime`, `BunContext`. Wraps `Bun.serve`. Direct dep: `@effect/platform-node-shared`. |

**Recommended `package.json` pins** (exact, same lockstep the registry published together):

```json
{
  "dependencies": {
    "effect": "3.22.1",
    "@effect/platform": "0.97.1",
    "@effect/platform-bun": "0.91.2"
  }
}
```

`@effect/platform-bun@0.91.2` also lists peers `@effect/cluster@^0.60.2`, `@effect/rpc@^0.76.2`, `@effect/sql@^0.52.1` with **no `peerDependenciesMeta` optional flags**. Those are only used by `BunClusterHttp` / `BunClusterSocket`. NQ should **not** install them for a single-process localhost Player Surface. Bun/npm may warn about missing peers; ignore unless Cluster is adopted.

### 1.2 Required vs optional modules

**Required for a localhost serve of one Campaign:**

- `HttpRouter`, `HttpServer`, `HttpServerResponse`, `HttpServerRequest`, `HttpMiddleware` from `@effect/platform`
- `BunHttpServer`, `BunRuntime` from `@effect/platform-bun`
- `Layer` / `Effect` / `Stream` from `effect`

**Optional (do not pull until a later ticket asks):**

| Module | Why optional |
| --- | --- |
| `HttpApi*` / `HttpApiSwagger` / `OpenApi` | Declarative typed API + generated `/docs`. README hello-world for Bun uses **`HttpRouter`**, not HttpApi. |
| `HttpClient` / `FetchHttpClient` | Needed in **tests** (`layerTest`) and if the server calls out. Not required to *listen*. |
| `Socket` / `HttpServerRequest.upgrade` | WebSocket path (constraint for the transport ticket). |
| `Ndjson` | Channel encoder for newline-delimited JSON over a byte stream. Not SSE. |
| `BunContext` / `BunFileSystem` / `Path` | Campaign FS stays NQ-owned (map lock). Only needed if serve uses platform FS for static files. |
| `HttpServerResponse.file` | Static HTML/JS/CSS for the web Player Surface if served from disk. |
| `@effect/platform-browser` | Browser-side Effect client. The v1 page can stay fetch/EventSource without it. |
| `@effect/vitest` | Official tests use it; NQ already uses `bun test`. |
| `@effect/platform-node` | Node listen path. NQ `engines.bun` is the runtime. |

---

## 2. `HttpServer` / routing / listen on localhost

### 2.1 Shape

From the platform README “HTTP Server” section:

- **HttpApp** = `Effect` that reads `HttpServerRequest` and (usually) yields `HttpServerResponse`.
- **Router** = HttpApp whose expected miss is `RouteNotFound`.
- **Handler** = per-route HttpApp with `RouteContext` + parsed search params.
- **Server** = takes a Default app and `serve`s it as a `Layer`.

Documented Bun hello world (same README):

```ts
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/", HttpServerResponse.text("Hello World"))
)
const app = router.pipe(HttpServer.serve(), HttpServer.withLogAddress)
const ServerLive = BunHttpServer.layer({ port: 3000 })
BunRuntime.runMain(Layer.launch(Layer.provide(app, ServerLive)))
// logs: Listening on http://localhost:3000
```

`HttpServer.serve(httpApp)` is a `Layer` that requires `HttpServer` in context. `HttpServer.serveEffect` is the Effect form used by official tests. `HttpServer.withLogAddress` logs `Listening on ${formatAddress(address)}` (`http://hostname:port` or `unix://path`).

### 2.2 Routing facts that constrain later API tickets

`HttpRouter` methods: `get` / `post` / `put` / `patch` / `del` / `head` / `options` / `all` / `route`. Paths are `` `/${string}` | "*" ``. Named params (`/todos/:id`) + `HttpRouter.schemaPathParams` / `schemaParams`. Mount: `HttpRouter.mount` (nested router) and `mountApp` (raw HttpApp). Catch: `catchTag` / `catchAll` / `catchAllCause`. Routes accept `{ uninterruptible?: boolean }` (see §4).

There is a second, Layer-oriented router (`HttpLayerRouter`) used in some official tests. Either works; `HttpRouter` is what the README teaches.

### 2.3 Binding loopback

`BunHttpServer.ServeOptions` is `Omit<Bun.ServeOptions, "fetch" | "error">` (plus TLS/unix variants) and is passed straight into `Bun.serve`. So **`port` and `hostname` are Bun’s**.

Facts:

- Official example passes only `{ port: 3000 }`. Bun’s default hostname is **`0.0.0.0`** (all interfaces) when unset.
- `formatAddress` prints whatever hostname Bun reports. The README’s “Listening on http://localhost:3000” is the **example output**, not a guarantee that the socket is loopback-only.
- `HttpServer.layerTestClient` remaps hostname `0.0.0.0` → `127.0.0.1` when building the test client URL — evidence that a default listen is not loopback.
- **Constraint for `nq serve`:** pass `hostname: "127.0.0.1"` (or `"localhost"`) explicitly if the product lock is “localhost only”. `port: 0` is valid (OS-assigned); `layerTest` uses that.
- Unix sockets are also in `ServeOptions` (`UnixServeOptions`). Not needed for a browser Player Surface.
- `layerConfig` wraps the same options in `effect/Config` if serve host/port become config later.

Launch is `Layer.launch` + `BunRuntime.runMain`. Process interrupt tears down the scoped `HttpServer` (`server.stop()` in the Bun finalizer).

---

## 3. Streaming incremental events (`prose_delta`)

This section lists **available primitives**. It does not pick a transport.

### 3.1 Byte / web stream (documented)

README “Streaming Responses”: return `HttpServerResponse.stream(stream)` where `stream` is `Stream<Uint8Array>`. Example spaces chunks with `Schedule.spaced`. `contentType` is an `Options` field (`HttpServerResponse.stream(body, { contentType })`).

On Bun, a `Stream` body becomes a WHATWG `ReadableStream` (`Stream.toReadableStreamRuntime`) inside `new Response(...)`. `HttpApp.unsafeEjectStreamScope` keeps the stream’s Scope open after the request Effect completes, then `Stream.ensuring(..., Scope.close)` closes it when the stream ends.

Also available:

- `HttpServerResponse.htmlStream` — incremental HTML template.
- `HttpServerResponse.raw` — pass through a native `Response` (Bun copies headers onto it).
- `HttpServerResponse.toWeb` / `fromWeb` — convert to/from Fetch `Response`.

**There is no `text/event-stream` helper and no `Sse` module on the v3 platform line.** `@effect/platform` modules include `Ndjson` (Channel pack/unpack of JSON lines) but not SSE framing. A later transport ticket that chooses SSE would encode `data: …\n\n` (or similar) into `Uint8Array` chunks itself, or wait for v4’s `effect/unstable/encoding/Sse` (RC only).

### 3.2 WebSocket (also first-class, also Unstable)

Every `HttpServerRequest` has `upgrade: Effect<Socket, RequestError>`. Bun implements it with `Bun.serve` `websocket` + `server.upgrade`. The resulting `Socket` has `run` / `runRaw` / `writer`. Close codes go through `Socket.defaultCloseCodeIsError`. `HttpServerRequest.upgradeChannel` is the Channel form.

This is enough for a later ticket to stream `prose_delta` over a socket **or** a response body. Both exist today.

### 3.3 Constraint for `prose_delta`

Whatever encoding is chosen must be a `Stream<Uint8Array>` (HTTP body) or `Socket` writes (upgrade). Play Events are not an Effect type in this package; mapping them is the adapter ticket.

---

## 4. Request cancel / interrupt mapping

### 4.1 What the platform already does

Bun request handler (`packages/platform-bun/src/internal/httpServer.ts`):

1. Fork the HttpApp fiber with the `HttpServerRequest` in context.
2. `request.signal.addEventListener("abort", () => runFork(fiber.interruptAsFork(Error.clientAbortFiberId)), { once: true })`.

The same `clientAbortFiberId` is used by `HttpApp.toWebHandlerRuntime` (generic Fetch adapter).

`HttpServerError.causeResponse` (`internal/httpServerError.ts`):

- Interrupt with `clientAbortFiberId` → empty response **status 499** (`clientAbortError`).
- Other interrupt → **503** (`serverAbortError`).
- Fail/Die → `Respondable` mapping (or 500).

Official test `"client abort"` (`platform-node/test/HttpServer.test.ts`): handler is `HttpServerResponse.empty().pipe(Effect.delay(1000), Effect.interruptible)`; client fiber is interrupted; stripped cause response status is **499**. A second unit test asserts `causeResponse` prefers `clientAbortFiberId` even when mixed with another interrupt.

### 4.2 What that means for a browser tab / POST abort

Fetch / EventSource / `AbortController.abort()` in the browser set `Request.signal`. Tab close typically aborts in-flight fetch. That is the same `abort` event Bun already maps to `clientAbortFiberId`.

**Constraints for the later Play Loop adapter (not a design):**

- Play Loop already exposes `interrupt()` which aborts its Turn `AbortController` and `session.abort()`. The HTTP fiber interrupt is the natural hook; the adapter must **keep the Turn Effect interruptible**. Default routes are interruptible. `{ uninterruptible: true }` (official test “uninterruptible routes”) would **swallow** tab-close and keep the Turn running.
- `HttpApp.toHandled` wraps the app in `Effect.uninterruptible` around scoped handling, then relies on the inner app / `Effect.interruptible` for cancel. Streaming bodies eject their Scope; aborting the request fiber still runs `Scope.close` on that ejected stream Scope, which should stop the `Stream`.
- 499 is how Effect *answers* a cancelled request. It is not a Play Loop fail reason. Mapping 499 / `clientAbortFiberId` → `PlayLoop.interrupt()` is adapter work.
- WebSocket close is a `SocketCloseError` / `closeDeferred`, not `clientAbortFiberId`. A WS transport would map socket close separately.

---

## 5. Test story

There is **no** exported `TestHttpClient` type. The documented stand-in is **`layerTest`**.

### 5.1 `BunHttpServer.layerTest` / `NodeHttpServer.layerTest`

From `BunHttpServer.ts` JSDoc: “Layer starting a server on a random port and producing an `HttpClient` with prepended url of the running http server.”

Implementation:

```ts
Server.layerTestClient.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { keepalive: false }))
  )),
  Layer.provideMerge(layer({ port: 0 }))
)
```

`HttpServer.layerTestClient` reads `HttpServer.address`, rejects Unix addresses, remaps `0.0.0.0` → `127.0.0.1`, and `HttpClient.mapRequest(prependUrl("http://host:port"))`.

So official “no hard-coded port” tests **still bind a real loopback socket** (ephemeral port). They are not a pure in-memory fake.

`NodeHttpServer.layerTest` is documented with this pattern:

```ts
Effect.gen(function*() {
  yield* HttpServer.serveEffect(HttpRouter.empty)
  const response = yield* HttpClient.get("/")
}).pipe(Effect.provide(NodeHttpServer.layerTest))
```

That is exactly how `packages/platform-node/test/HttpServer.test.ts` is written (`it.scoped` + `Effect.provide(NodeHttpServer.layerTest)`). **`packages/platform-bun` has no HTTP server test files** on the v3 commit inspected; Bun’s `layerTest` is the same contract.

NQ can copy that pattern with `BunHttpServer.layerTest` under `bun test` (no `@effect/vitest` required).

### 5.2 In-process, no listen

`HttpApp.toWebHandler` / `toWebHandlerRuntime` / `toWebHandlerLayer` turn an HttpApp into `(request: Request) => Promise<Response>` and still honor `request.signal` → `clientAbortFiberId`. Useful for unit tests of routing/encoding without `Bun.serve`. This is the closest thing to “without binding a real port.”

`HttpServerRequest.fromWeb` / `HttpServerResponse.toWeb` support the same conversion.

---

## 6. Version / stability — what NQ should pin

| Line | State (2026-08-13) | HTTP location |
| --- | --- | --- |
| **v3 (npm `latest`)** | `effect@3.22.1`, platform `0.97.1`, platform-bun `0.91.2`. Website docs: `/docs/v3/…`. Source: `v3` branch / commit `bd20125`. | `@effect/platform` + `@effect/platform-bun` |
| **v4 RC** | `main` README: “Effect V4 is currently a release candidate.” Install `effect@rc`. Requires TypeScript **5.9+**. Packages on npm `rc` tag. | HTTP moved **into** `effect/unstable/http/*`. SSE encoder appears as `effect/unstable/encoding/Sse`. platform-bun lives at `packages/platform/bun`. |

v3 platform introduction still marks Http Server / Client / API / Socket **Unstable**. Pinning v3 does not make those modules Stable; it only picks the documented, `latest`-tagged line.

**Pin v3 lockstep (`3.22.1` / `0.97.1` / `0.91.2`).** Reasons that are facts, not preference:

1. `nq serve` can be written against the published README Bun example today.
2. v4 relocates every HTTP import (`@effect/platform/HttpServer` → `effect/unstable/http/HttpServer`) and is still RC.
3. NQ already has TypeScript `^5.9.3`, so a later v4 move is not blocked by the compiler — only by import/API churn.
4. An SSE-specific encoder exists on v4 (`Sse`) and **not** on v3 platform. That is a constraint for the transport ticket, not a reason to take RC for the envelope.

When (if) NQ moves to v4, treat it as a dedicated upgrade: new import map, new `BunHttpServer` package path, review `HttpApiTest` / `Sse`.

---

## Constraints to hand later tickets

- **Web transport:** both `HttpServerResponse.stream` (HTTP body / DIY SSE or NDJSON) and `HttpServerRequest.upgrade` (WebSocket `Socket`) exist on the v3 Bun server. No official SSE module on v3. v4 `Sse` is RC-only.
- **Play Loop adapter:** request abort is already an Effect interrupt (`clientAbortFiberId`, status 499). `PlayLoop.interrupt()` is a separate Promise/`AbortController` API. The adapter must join those without marking Turn routes `uninterruptible`.
- **Serve bind:** set `hostname` explicitly to loopback; do not rely on the README’s “localhost” log string.
- **Tests:** use `BunHttpServer.layerTest` (ephemeral port + real `HttpClient`) or `HttpApp.toWebHandler` (no socket). There is no `TestHttpClient` name.
