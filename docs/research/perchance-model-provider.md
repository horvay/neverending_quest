# Perchance as a model provider

Research note for Neverending Quest. This note assesses Perchance's official AI text plugin and the browser requests exposed by its first-party source. It uses only Perchance pages, Perchance-hosted source, Perchance legal pages, and a direct observation of the Perchance-hosted endpoint.

Investigated on 2026-08-24. Perchance does not publish a semantic version for the AI text plugin. The inspected plugin revision reports `generatorLastEditTime=1787544955878`, which is 2026-08-24T04:15:55.878Z, in the [first-party `ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit). The inspected verifier was the live [Perchance text-generation embed](https://text-generation.perchance.org/embed). The legal snapshot is the [Terms of Service updated 2026-07-18](https://perchance.org/terms-of-service) and the [Privacy Policy updated 2020-06-22](https://perchance.org/privacy-policy).

## Recommendation

Reject Perchance as a Neverending Quest model provider.

Perchance has a supported text-generation interface for code running inside a Perchance generator. It does not document a supported external model API, provider credential, or chat-completions contract. Its own older DIY API page says Perchance does not have an API and tells users to run a downloaded ordinary generator through their own Node.js script instead. That page predates the current AI plugin, but no newer first-party page found in this investigation offers the AI text backend as an external API. See the [`ai-text-plugin` documentation](https://perchance.org/ai-text-plugin), the [DIY Perchance API page](https://perchance.org/diy-perchance-api), and the [current internal embed](https://text-generation.perchance.org/embed).

The live implementation makes direct integration unsuitable even as an unofficial adapter. A Perchance page creates a hidden cross-origin iframe, obtains browser-local user keys through Perchance verification and Cloudflare Turnstile, and sends generation commands to that iframe with `postMessage`. The iframe rejects parent messages whose origin does not end in `.perchance.org`. It then calls an internal `/api/generate` route with the browser-local key. These are implementation details, not a published contract. See the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit) and [embed source](https://text-generation.perchance.org/embed).

The policy bar is also decisive. The Terms say users must not access the Services through automated or non-human means, must not bypass access restrictions, and must not create an undue burden. They also reserve the right to change or discontinue the service without notice. A desktop provider adapter that copies internal browser requests would depend on exactly the access path the Terms do not approve. See [Terms sections 3, 5, and 14](https://perchance.org/terms-of-service).

Do not build or prototype a Neverending Quest provider against `text-generation.perchance.org/api/*`. If prompt-quality exploration is still useful, run it manually through a Perchance-hosted generator and treat it only as a product experiment, not as evidence that an external integration is available.

## Evidence categories

This note uses four categories:

1. Documented and supported means the public `ai-text-plugin` interface intended for use by Perchance generators.
2. Observable but unsupported means routes, request fields, verification steps, and stream framing visible in Perchance-hosted source or direct network behavior, but not offered as an external API.
3. Policy and operational constraints come from Perchance's Terms, Privacy Policy, and plugin documentation.
4. Inference identifies conclusions for Neverending Quest that the sources do not state directly.

The distinction matters because the internal service is technically callable by its own iframe, but technical visibility does not make it a public provider API.

## Documented and supported interface

The supported entry point is a Perchance plugin import:

```perchance
ai = {import:ai-text-plugin}
```

A generator can pass a string, which the plugin treats as `instruction`, or an object. The public prompt options are `instruction`, `startWith`, `stopSequences`, `hideStartWith`, `outputTo`, `onChunk`, `onStart`, `onFinish`, `render`, and `endButtons`. The documentation also shows JavaScript-style use with `await ai({ instruction, onChunk })`. See the [official plugin page and source](https://perchance.org/ai-text-plugin#edit).

The source-level callable is:

```text
$output(inputData, extraOpts) =>
```

It returns a promise-like object. On completion, `result.text` includes `startWith`, while `result.generatedText` excludes it. During generation, callers can use `onChunk`, inspect `liveResponseText`, consume `textStream`, or call `stop()`. This is a real streaming interface for code inside a Perchance generator. See the [official plugin page and source](https://perchance.org/ai-text-plugin#edit).

The plugin exposes only a text instruction and continuation controls. It does not document `messages`, roles, a distinct system prompt, model selection, temperature or sampling controls, a token limit, JSON Schema, response formats, tools, or tool choice. The source constructs generation data from `instruction`, `startWith`, `stopSequences`, and `generatorName`. See the public option list and request construction in the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit).

The plugin source currently reports `idealMaxContextTokens: 6000` as a recommendation, not a fundamental limit. The live embed calculates an input budget as `8000 - 1024`, then middle-out truncates `instruction` and `startWith` when their combined token count exceeds that budget. One image attachment reduces the text budget further. These values are implementation details and may change because the plugin has no versioned capability contract. See the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit) and [embed source](https://text-generation.perchance.org/embed).

The plugin documentation says each user can have only a few concurrent server requests and that additional completions queue. The current embed sets `maxThreadsPerUser` to `2` and has explicit `waiting_for_prev_request_to_finish` handling. This establishes a current browser-client concurrency shape, but it does not establish a contractual server quota or throughput limit. See the [plugin notes](https://perchance.org/ai-text-plugin) and [embed source](https://text-generation.perchance.org/embed).

The plugin is funded by ads shown to non-logged-in users on generators that import it. Perchance does not publish external API pricing, purchased capacity, quota management, or an SLA on the plugin page. See the [official plugin funding explanation](https://perchance.org/ai-text-plugin) and [Terms sections 9 and 14](https://perchance.org/terms-of-service).

## Observable but unsupported request path

The following trace comes from current first-party source. It describes how Perchance implements its plugin, not an external API promise.

1. The plugin sets `serverOrigin` to `https://text-generation.perchance.org`, creates a hidden iframe at `/embed`, and waits for `embedIsReady`. See the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit).
2. The plugin sends the iframe a `startStream` message containing the URL `/api/generate`, generation data, a request ID, and the Perchance generator origin. See the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit).
3. The iframe accepts messages only from its parent and only when the parent origin ends with `.perchance.org`. It therefore does not expose this bridge to an arbitrary application origin. See the [embed source](https://text-generation.perchance.org/embed).
4. The iframe verifies the browser, stores `userKey-<thread>` values in `localStorage`, and may load Cloudflare Turnstile. Verification calls include `/api/verifyUser` and `/api/checkUserVerificationStatus`. See the [embed verification source](https://text-generation.perchance.org/embed).
5. The iframe sends `POST /api/generate?userKey=...&thread=...&requestId=...` with a JSON body. The source uses no `Authorization` header and exposes no developer API key flow. A response can rotate the browser key through `x-new-user-key` or ask for re-verification through `x-should-reverify`. See the [embed request source](https://text-generation.perchance.org/embed).
6. The response is streamed as newline-delimited records. Lines beginning with `t:` contain a JSON string text chunk. Lines beginning with `data:` contain a JSON object. This is a custom stream parser, not an OpenAI-compatible server-sent event schema. See the [embed stream parser](https://text-generation.perchance.org/embed).
7. The iframe sends chunks back to the Perchance generator with `postMessage`. The public plugin converts them into `onChunk` callbacks and a `ReadableStream`. See the [embed source](https://text-generation.perchance.org/embed) and [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit).

A direct command-line `POST` to [`https://text-generation.perchance.org/api/generate`](https://text-generation.perchance.org/api/generate) on 2026-08-24, with a small JSON prompt and no browser verification state, returned HTTP 403 with `cf-mitigated: challenge` from Cloudflare. This observation is only a point-in-time probe. It confirms that a plain server-side HTTP client cannot treat the visible route as an anonymous API.

The embed contains retries, keepalives, queue polling, verification refresh, a 60-second connection-start timeout, a 60-second mid-stream stall watchdog, and continuation after certain network failures. A provider implementation would have to reproduce or continually track this private browser protocol. See the [embed generation and stream source](https://text-generation.perchance.org/embed).

The plugin source starts with a warning not to vendor or fork it because its code is coupled to server code and a copied version is likely to break when the server changes. It recommends importing the official plugin and using only its public API. This warning directly argues against implementing the internal HTTP protocol in Neverending Quest. See the [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit).

## Chat-completion compatibility

| Dimension | Established fact | Neverending Quest assessment |
| --- | --- | --- |
| Authentication | The public plugin has no developer key. The internal embed uses browser-local `userKey` values and Cloudflare Turnstile, and it only accepts commands from a `.perchance.org` parent. [Embed source](https://text-generation.perchance.org/embed) | Incompatible with a server or desktop provider credential. Reproducing browser verification would be unsupported. |
| Models | The public API has no model field or model-list operation. The embed loads the `deepseek-ai/DeepSeek-R1-0528` tokenizer, but tokenizer identity does not prove which serving model or models produce output. [Plugin source](https://perchance.org/ai-text-plugin#edit), [embed tokenizer source](https://text-generation.perchance.org/embed) | Serving model, model lifecycle, capabilities, and reproducibility are unknown. Never label it DeepSeek-R1-0528 from tokenizer evidence alone. |
| Streaming | `onChunk` and `textStream` are supported inside Perchance. Internally, the iframe parses custom `t:` and `data:` lines and forwards text chunks. [Plugin source](https://perchance.org/ai-text-plugin#edit), [embed stream parser](https://text-generation.perchance.org/embed) | Text streaming exists, but not through a supported external or OpenAI-compatible protocol. |
| System prompts | The documented input is one `instruction` plus `startWith`; no role-separated system field is documented. [Plugin options](https://perchance.org/ai-text-plugin) | A system prompt and chat history could only be flattened into prompt text. Priority and isolation semantics are unknown. |
| Chat history | Perchance publishes chat examples, but the plugin request remains a single instruction and prefix rather than a `messages[]` conversation. [Plugin examples and source](https://perchance.org/ai-text-plugin#edit) | Basic conversational prompting is possible. Native role handling, cached conversation state, and turn-level metadata are absent or unknown. |
| Structured output | The public options and internal request construction expose no JSON mode, JSON Schema, grammar, or response-format field. [Plugin source](https://perchance.org/ai-text-plugin#edit) | Prompted JSON may work as ordinary text, but constrained output and reliability are unknown. It cannot satisfy a provider capability flag for structured output. |
| Tool calls | The public interface exposes no tools, tool schemas, tool choice, or tool-call response shape. [Plugin source](https://perchance.org/ai-text-plugin#edit) | Unsupported as a first-class feature. Parsing ad hoc text would not be equivalent to tool calls. |
| Context | The plugin recommends 6000 tokens. The current embed budgets 6976 input tokens for text-only requests and middle-out truncates overlong inputs. [Plugin source](https://perchance.org/ai-text-plugin#edit), [embed source](https://text-generation.perchance.org/embed) | Too small and too opaque for an accumulating campaign unless Neverending Quest performs aggressive context assembly. Silent middle-out truncation can remove campaign facts from the middle of a prompt. |
| Output limit | The public interface does not document a maximum output-token control or guaranteed maximum response size. [Plugin options](https://perchance.org/ai-text-plugin) | Unknown. Neverending Quest could stop a stream client-side, but cannot request a contractual output budget. |
| Rate limits | Documentation says a few concurrent requests per user and queuing. The current client uses two threads. No requests-per-minute, tokens-per-minute, burst, or capacity guarantee is published. [Plugin notes](https://perchance.org/ai-text-plugin), [embed source](https://text-generation.perchance.org/embed) | Insufficient for provider planning, backoff policy, or capacity expectations. |
| Commercial use | Perchance expressly allows commercial use of generated text, requires no attribution, and says it does not claim copyright in generated output. It also allows generator monetization. [Terms FAQ](https://perchance.org/terms-of-service) | Output use is commercially allowed. This does not grant permission to repurpose internal endpoints as a commercial provider API. |
| Cost and account controls | The supported plugin is ad-funded. No external usage billing, organization account, spend cap, quota dashboard, or service tier is documented. [Plugin page](https://perchance.org/ai-text-plugin) | No provider operations surface. The economics of direct application traffic are undefined. |
| Data handling | Perchance says the AI text plugin does not store prompt or response data on the server, and says login is not associated with AI requests. It separately records IP, browser, device, referral, page, time, and usage data for abuse detection and statistics. The Terms say the Services are hosted in the United States. [Privacy key points and automatic collection](https://perchance.org/privacy-policy), [Terms section 11](https://perchance.org/terms-of-service) | Better than unknown prompt retention, but not an enterprise data-processing commitment. Retention for transient processing, model-provider subprocessors, training use beyond the no-storage statement, deletion controls, and a DPA are unknown. Do not send secrets or regulated data. |
| Stability and support | The plugin is unversioned and coupled to private server code. The Terms allow modification, suspension, or discontinuance at any time without notice and disclaim availability guarantees. [Plugin source warning](https://perchance.org/ai-text-plugin#edit), [Terms section 14](https://perchance.org/terms-of-service) | High breakage and operational risk. There is no stable provider contract or SLA. |

## Policy and operational constraints

The Terms explicitly allow commercial use of generated images and text and require no attribution. They also say the FAQ answer allowing generator monetization overrides contradictory boilerplate. This settles rights in output and hosted generators, not access rights to internal model endpoints. See the [Terms FAQ](https://perchance.org/terms-of-service).

The same Terms state that users will not access the Services through automated or non-human means, interfere with access controls, bypass measures designed to restrict access, or create an undue burden. They allow commercial endeavors only when specifically endorsed or approved. The supported ad-funded plugin path is endorsed; an external application calling private routes is not documented as endorsed. See [Terms sections 3 and 5](https://perchance.org/terms-of-service).

Perchance limits the Services to users at least 18 years old and says they are not tailored for HIPAA, FISMA, GLBA, or similar regulated use. Neverending Quest would need to carry those restrictions if it depended on the service. See [Terms section 1](https://perchance.org/terms-of-service).

The Privacy Policy's no-storage statement is specific to the AI text plugin. It warns that any Perchance page can be created by anyone and advises users never to enter private or sensitive data into arbitrary generators. It also describes advertising cookies and automatic traffic logging. See the [Privacy Policy key points, automatic collection, and advertising sections](https://perchance.org/privacy-policy).

The service has no published availability commitment. The Terms reserve the right to modify or discontinue it without notice and disclaim liability for downtime. The client source itself contains recovery logic for queueing, stale requests, verification failure, timeouts, and interrupted streams. See [Terms section 14](https://perchance.org/terms-of-service) and the [embed source](https://text-generation.perchance.org/embed).

## Inferences for Neverending Quest

These points are architectural inferences from the cited facts, not Perchance claims.

1. Wrapping a hidden Perchance generator in a browser would not turn the plugin into a supported provider. It would add Chromium, iframe lifecycle, ad behavior, Turnstile, local storage, and origin constraints to a TUI model call while still relying on an unversioned service. Evidence: [plugin transport](https://perchance.org/ai-text-plugin#edit), [embed verification](https://text-generation.perchance.org/embed), and [plugin funding](https://perchance.org/ai-text-plugin).
2. Flattening system instructions, dossiers, player state, and chat turns into one `instruction` can produce text, but it loses role separation and makes the current middle-out truncation hazardous for campaign continuity. Evidence: [plugin inputs](https://perchance.org/ai-text-plugin#edit) and [embed truncation](https://text-generation.perchance.org/embed).
3. Prompting for JSON cannot substitute for schema-constrained output when campaign state updates must be validated and applied reliably. The source exposes ordinary text only. Evidence: [plugin options and result shape](https://perchance.org/ai-text-plugin#edit).
4. The commercial-output permission does not cure access risk. Neverending Quest needs both the right to use outputs and a supported way to obtain them. The sources establish the first and not the second. Evidence: [Terms FAQ and access restrictions](https://perchance.org/terms-of-service), [DIY API page](https://perchance.org/diy-perchance-api), and [plugin source](https://perchance.org/ai-text-plugin#edit).
5. Even a successful one-off browser call would prove model quality only. It would not prove stable authentication, model identity, external-use permission, rate limits, structured output, tool use, data-processing terms, or availability. Evidence: the compatibility gaps above and [Terms section 14](https://perchance.org/terms-of-service).

## Decision record

| Choice | Decision | Reason |
| --- | --- | --- |
| Integrate as a provider | No | No supported external API, provider authentication, model contract, or policy basis for internal endpoint use. |
| Prototype an adapter against internal routes | No | It would reproduce a private browser protocol, conflict with access restrictions, and create misleading technical momentum around an integration that cannot ship. |
| Run a manual prompt-quality experiment on Perchance | Optional | This stays within the documented hosted-generator interface, but it must not be treated as provider validation. |
| Revisit later | Yes, only if Perchance publishes an external API | Re-evaluate when first-party documentation provides authentication, terms for automated external use, model and capability metadata, limits, data-processing commitments, and a versioned stability policy. |

Perchance is a capable hosted generation feature for Perchance pages. It is not a viable model provider for Neverending Quest under the current documented interface, observable implementation, and terms.

