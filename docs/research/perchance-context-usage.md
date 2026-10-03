# Perchance token-level context visibility

Research note for Neverending Quest. This note answers whether a Perchance generator can inspect token-level context use when calling the official AI text plugin, and whether the completion returns token usage. It uses current first-party Perchance pages and source only.

Investigated on 2026-08-26. The inspected `ai-text-plugin` revision reports `generatorLastEditTime=1787748875603` in the [live plugin source](https://perchance.org/ai-text-plugin#edit). The transport implementation was the current [Perchance text-generation embed](https://text-generation.perchance.org/embed). The first-party applications inspected were [AI Character Chat](https://perchance.org/ai-character-chat#edit) and the smaller [AI Chat Example](https://perchance.org/ai-chat-example#edit).

## Direct answer

Perchance provides an **approximate local token counter**, but it does **not** expose authoritative current-context usage or per-completion usage through the documented `ai-text-plugin` result.

| Question | Answer |
| --- | --- |
| Can a generator get a token-level estimate before a call? | **Yes.** `ai({getMetaObject:true}).countTokens(text)` returns an approximate count for text supplied by the caller. This helper is present in the official plugin source and used by the first-party AI Character Chat, but it is not listed in the plugin page's documented prompt options. |
| Can a generator read the exact prompt/context tokens the service actually used? | **No supported field.** The generator can count its own assembled text, but cannot read the private iframe's post-truncation count or verify the server/model's final tokenization. |
| Is token usage available while streaming? | **No.** The public callbacks expose text progress, not prompt, completion, or total tokens. A generator can repeatedly run the approximate counter over its own text if an estimate is sufficient. |
| Does the completed result return usage? | **No.** The current public result contains `text`, `generatedText`, and `stopReason`; there is no `usage`, `promptTokens`, `completionTokens`, or `totalTokens` field. |
| Does the private implementation calculate token counts? | **Yes, internally.** The cross-origin embed calculates `instructionTokenCount` and `startWithTokenCount` after possible middle-out truncation and sends them in the private request body. Those fields are not surfaced back through the plugin API and may themselves be approximate. |

The practical distinction is: a generator can estimate **the text it plans to use**, but cannot query **what the model actually consumed** or **how many tokens the completion used**.

## Evidence

### 1. The plugin exposes an approximate pre-call counter

The official [`ai-text-plugin` source](https://perchance.org/ai-text-plugin#edit) handles `getMetaObject: true` before starting a generation. The source describes the implementation as a "Fast bigram-based approx token counter thingy" and returns:

```js
return {
  countTokens: function(text) {
    return Math.ceil(countTokensApprox(text));
  },
  idealMaxContextTokens: 6000, // this is just a recommendation - not a fundamental limit
};
```

This is genuine generator-runtime access to a token-shaped estimate:

```js
const { countTokens, idealMaxContextTokens } = ai({ getMetaObject: true });
const estimatedTokens = countTokens(instruction + startWith);
```

It is not an observation of a generation request. The helper accepts only caller-provided text, runs locally, and is explicitly approximate. It has no request ID, no server round trip, and no knowledge of later iframe/server truncation. The source publishes no accuracy bound, model-tokenizer compatibility guarantee, or versioned stability contract for it. The public plugin page's "Prompt Options" list also does not document `getMetaObject`, `countTokens`, or `idealMaxContextTokens`; their strongest first-party status is source-visible and first-party-used rather than a documented guarantee.

### 2. Perchance's own character chat uses the estimate for context management

The official [AI Character Chat source](https://perchance.org/ai-character-chat#edit) demonstrates the intended practical use. It obtains the helper and keeps a safety margin below the recommendation:

```js
const { countTokens, idealMaxContextTokens } = root.aiTextPlugin({getMetaObject:true});
let tokenCountToIdeallyStayUnder = idealMaxContextTokens-800;
```

It then counts the locally assembled messages, after replacing older messages with summaries:

```js
let currentlyUsedContextLength = countTokens(
  messageTextWithSummaryReplacements.join("\n\n") +
  (opts.extraTextForAccurateTokenCount || "")
);
```

If that estimate exceeds its threshold, the application summarizes older chat content. Its output script also assigns the helper to `window.countTokens`. This first-party example confirms that token estimation is usable by generator code. It does not convert the estimate into exact backend telemetry: the application chooses the input string, the counter is the plugin's approximate bigram model, and the `-800` margin is application policy.

The smaller official [AI Chat Example source](https://perchance.org/ai-chat-example#edit) sends the accumulated chat log as `startWith` and receives only text in `onChunk`/`onFinish`; it contains no response usage field. Together, the examples show local context assembly rather than a server-maintained conversation whose current token usage can be queried.

### 3. Public streaming and completion objects omit usage

In the official [`ai-text-plugin` implementation](https://perchance.org/ai-text-plugin#edit), `onChunk` receives:

- `fullTextSoFar`
- `textChunk`
- optionally `isFromStartWith`

The promise-like object available at start exposes the original `inputs`, `liveResponseText`, `textStream`, `stop()`, `id`, and display/rating helpers. At completion, `doOnFinishStuff` constructs the resolved value as a `String` object with exactly these attached fields:

```js
finishData.text = chunks.join("");
finishData.generatedText = generatedChunks.join("");
finishData.stopReason = stopReason;
```

No branch attaches input tokens, output tokens, total tokens, a usage object, or post-truncation prompt metadata. Therefore token usage is unavailable through both `await ai(...)` and `onFinish(data)`.

The plugin also deliberately narrows each private iframe message. From `event.data.value` it copies `text` and, when present, `stopReason`; it derives first/last-chunk flags locally. Unknown private response properties are not copied into public chunk callbacks or the final result. This is stronger evidence than the documentation's silence: current source defines the actual result construction and contains no usage path.

### 4. The private embed counts input tokens, but does not expose them

The current [text-generation embed source](https://text-generation.perchance.org/embed) runs in the hidden `https://text-generation.perchance.org` iframe. It currently sets the text-only input budget as:

```js
const maxContextTokens = Number("8000") - 1024;
```

One image subtracts a further internal image cost. The embed tries to load a tokenizer, counts `instruction` and `startWith`, and middle-out truncates them while their sum exceeds the budget. If tokenizer loading or performance is unsuitable, it falls back to character-based estimates (`3.9` characters per token normally and `3.4` for detected French) and uses a safety margin.

After trimming, it adds these private request fields:

```js
postData.startWithTokenCount = window.tokenizer && !tokenizerWillBeTooSlow
  ? window.tokenizer.encode(postData.startWith).length
  : Math.round(postData.startWith.length / approxCharsPerToken);
postData.instructionTokenCount = window.tokenizer && !tokenizerWillBeTooSlow
  ? window.tokenizer.encode(postData.instruction).length
  : Math.round(postData.instruction.length / approxCharsPerToken);
```

It then posts that body to the private `/api/generate` route. These counts are implementation inputs to the backend, not a generator API:

1. They are calculated inside a cross-origin iframe after the generator sends its request.
2. The iframe never posts those counts back to the generator.
3. They can be exact for the embed's loaded tokenizer or character-based estimates on its fallback path.
4. The current source loads the `deepseek-ai/DeepSeek-R1-0528` tokenizer, but tokenizer identity does not document or prove the serving model's identity.
5. The 6976-token text budget is a current implementation value, not a documented context-window guarantee.

The private response parser accepts `t:` text records and generic `data:` JSON records. The current client handles `text`, `final`, `stopReason`, and error/status control fields. It does not name or consume a usage field. Because the `data:` parser is generic, source inspection cannot prove that the private server will never add hidden metadata; it does establish that no such metadata is part of the supported plugin result, and current plugin code would discard unknown fields.

## Availability by phase

### Before a call

Available:

- An approximate token count for any string the generator supplies to `countTokens(text)`.
- The source-visible recommendation `idealMaxContextTokens: 6000`.
- The generator's own character counts and prompt assembly state.

Unavailable:

- Authoritative post-truncation prompt tokens.
- Server-side formatting/framing tokens.
- A documented model tokenizer or exact context limit.
- Tokens already consumed by a server-maintained conversation; `ai-text-plugin` sends `instruction` and `startWith`, not a conversation ID with queryable usage.

### During a call

Available:

- Text chunks, full text so far, and a live text string.
- A locally recomputed approximate count if the generator calls `countTokens` itself.

Unavailable:

- Prompt-token usage, generated-token usage, remaining context, or an authoritative running total.

### After a call

Available:

- `text`, `generatedText`, and `stopReason`.
- A locally recomputed approximate count of the returned text.

Unavailable:

- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, or Perchance equivalents.
- The exact input after all client/server truncation.
- An indication of cached tokens, hidden framing, image tokens actually charged, or model-side accounting.

## Limitations and undocumented points

The following remain undocumented by Perchance:

- Accuracy and error bounds of `countTokens`.
- Whether its approximation is calibrated to every model Perchance may serve.
- Whether `getMetaObject` and its field names are a stable public contract.
- The serving model, its tokenizer, its complete context window, and its output-token ceiling.
- Exact server-side prompt construction and any truncation beyond the visible embed logic.
- Per-completion prompt, completion, total, cached, or image-token usage.
- Whether private `data:` records can contain additional metadata at other times; no such metadata is surfaced by the public plugin today.

No authenticated generation probe was required to settle the public API question: the first-party plugin source constructs the callback and result objects itself, and those paths omit usage. The private endpoint is not a supported external API, so its unversioned wire shape would not provide a safe contract even if a point-in-time response exposed extra fields.

## Recommendation for Neverending Quest

Do not treat Perchance as providing token-usage telemetry.

For a manual experiment inside a Perchance-hosted generator, use `countTokens` only as a conservative pre-call estimate over the exact concatenated `instruction` and `startWith` text, keep meaningful headroom below `idealMaxContextTokens`, and assume the private client may still middle-out truncate. The first-party character chat's summarization threshold demonstrates this approach. A local estimate can also be shown after completion, but it must be labeled approximate and must not be presented as provider-reported usage.

For Neverending Quest's provider architecture, Perchance cannot satisfy an observability requirement for authoritative context use or completion usage. Do not derive billing, remaining-context guarantees, or campaign-memory safety from the approximate helper. Maintain application-owned prompt-size policy independently, and require a future supported provider contract to expose model identity, tokenizer/context limits, truncation behavior, and response usage before relying on token-level accounting.
