# Long-horizon agent memory patterns

Primary-source pattern extractions for Neverending Quest’s hybrid **Dossier + Episodic Memory** design and **Context Assembly** pin policy. Not a product comparison.

Standing NQ choices this note feeds: hybrid entity records + managed episodic log; same-model structured Side-channel writes; pin priority under pressure = Dossiers + Player Sheet first, then recent messages; no vector-only RAG as primary model.

---

## Sources

| System | Kind | Link |
| --- | --- | --- |
| MemGPT | Paper | [Packer et al., arXiv:2310.08560](https://arxiv.org/abs/2310.08560) · [HTML](https://ar5iv.labs.arxiv.org/html/2310.08560) |
| Letta (MemGPT successor) | Official docs | [Stateful agents](https://docs.letta.com/concepts/stateful-agents/index.md), [MemFS](https://docs.letta.com/concepts/memfs/index.md), [Memory & dreaming](https://docs.letta.com/configuration/memory/index.md) |
| Generative Agents | Paper | [Park et al., arXiv:2304.03442](https://arxiv.org/abs/2304.03442) · [HTML](https://ar5iv.labs.arxiv.org/html/2304.03442) · [repo](https://github.com/joonspk-research/generative_agents) |
| Anthropic | Official docs + eng post | [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction), [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| Claude Code | Official docs | [Memory (CLAUDE.md + auto memory)](https://code.claude.com/docs/en/memory) |

Secondary papers useful only as adjacent patterns (not required for NQ v1): Reflexion (verbal failure notes, arXiv:2303.11366); Voyager skill library (procedural code memory, arXiv:2305.16291).

---

## 1. Tiered memory (always-on vs external)

### Pattern

Split storage into (A) **main context** that the model sees every inference and (B) **external stores** that must be explicitly moved in before they affect generation.

**MemGPT** names the split explicitly (paper §2):

- **Main context (prompt tokens)** = system instructions (read-only) + **working context** (fixed-size R/W text) + **FIFO queue** of recent messages (with index-0 recursive summary of what was evicted).
- **External context** = **recall storage** (full conversation DB, searchable) + **archival storage** (arbitrary long-term notes/docs, searchable). Nothing external is visible until a function call pages it into main context.

**Letta MemFS** keeps the same idea as files ([MemFS docs](https://docs.letta.com/concepts/memfs/index.md)):

- Files under `system/` are loaded into the system prompt **every turn** (persona, human prefs, critical durable facts).
- Files outside `system/` stay discoverable in the memory tree but load **only when relevant**.
- Default search is file tools, not a mandatory vector index; optional search mod exists separately. Conversation-history search is a **separate** store from MemFS.

**Anthropic** separates durable memory from session context:

- **Memory tool**: client-side file ops under `/memories`; model reads/writes on demand; “just-in-time” retrieval so active context stays task-focused ([Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- **Compaction**: server-side summary of *this* conversation when tokens hit a trigger; replaces older blocks with a `compaction` summary — **not** a durable cross-session store ([Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)).
- Eng post: treat context as a finite attention budget; prefer smallest high-signal token set; pair compaction with **structured note-taking outside the window** for long-horizon work ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Claude Code** ([Memory docs](https://code.claude.com/docs/en/memory)):

- **CLAUDE.md / rules**: human-authored, loaded every session (project/user/org scopes) — pin-like instructions.
- **Auto memory**: model-written learnings, loaded every session but **capped** (first 200 lines or 25KB) — bounded always-on notes, not full history.

### NQ mapping

| Tier | NQ analogue | Assembly role |
| --- | --- | --- |
| Always-on working / `system/` / CLAUDE.md | **Player Sheet** + **pinned Dossiers** + GM seed voice | Hard pins under budget pressure |
| FIFO recent + recursive eviction summary | Recent Turn transcript + optional rolling summary of dropped Turns | Soft pin after hard pins |
| Recall (conversation search) | Full Campaign transcript index | Retrieve on demand, never whole-stuff |
| Archival / non-`system` files / memory tool files | **Episodic Memory** log + non-pinned Dossiers | Retrieve by relevance / name / tags |
| Compaction alone | **Not** a substitute for Dossier/Episodic writes | Session hygiene only |

---

## 2. Entity-like state vs episodic notes

### Pattern

Long-horizon systems that stay coherent separate **mutable named state** (who/what is true now) from **append-only experience** (what happened).

**MemGPT working context** is the entity-ish tier: “key facts, preferences, and other important information about the user and the persona” edited via explicit memory functions; size-capped because it burns tokens every turn (paper §2.1, Fig. 4).

**Generative Agents** keep almost everything as natural-language **memory objects** in a **memory stream**, then *synthesize upward* (paper §4):

- **Observation**: raw perceived event (episodic leaf).
- **Reflection**: higher-level inference citing supporting memories; stored back into the stream; can stack into reflection trees (entity-ish traits emerge, e.g. “Klaus is dedicated to research”).
- **Plan**: future action sequence, also stored and retrieved like memory.
- Seed identity is a short natural-language paragraph split into initial memory rows — not a separate hard schema, but functionally a starting dossier.

**Letta**: durable identity/prefs live as edited Markdown in `system/`; deeper project notes live under `reference/` etc., loaded when needed ([MemFS](https://docs.letta.com/concepts/memfs/index.md)). Memory is shared across an agent’s conversations ([Stateful agents](https://docs.letta.com/concepts/stateful-agents/index.md)).

**Anthropic memory tool** examples organize files by concern (`user_profile`, `preferences`, project notes) rather than one blob — entity/topic files plus free notes ([Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).

### NQ mapping

- **Dossier** ≈ MemGPT working-context *slots* / Letta `system/` or named topic files / GA reflections about a person-place-thing: named, updated, must not be forgotten when relevant.
- **Episodic Memory** ≈ GA observations (+ maybe low-level reflections not yet folded into a Dossier) / MemGPT archival inserts / free memory-tool notes.
- **Player Sheet** ≈ always-on human/persona block (Letta `human.md` + critical character facts); higher pin priority than world Dossiers.
- **Graduation path (design signal)**: episodic observations accumulate → periodic reflection/synthesis → durable fields land on a Dossier (or Player Sheet). GA does this via importance-triggered reflection; Letta via “dreaming” background subagents ([Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)).

---

## 3. What is pinned vs retrieved (Context Assembly)

### Pattern: pin the small durable core; retrieve the rest

Convergent rule across sources:

1. **Always pin** a small, curated core (identity, critical standing facts, instructions).
2. **Always include** a tail of **recent interaction**.
3. **Retrieve** everything else just-in-time (search, named read, embedding, or filesystem walk).
4. Under overflow, **evict or summarize the middle**, not the core pins.

Concrete mechanisms:

| Source | Always in prompt | Recent | Retrieved |
| --- | --- | --- | --- |
| MemGPT | System instructions + working context | FIFO queue; eviction replaces old msgs with recursive summary at queue head | `recall` / `archival` search → pages results into queue |
| Letta | `system/**` Markdown | Current conversation thread | Non-system MemFS files; message search |
| Generative Agents | Short agent summary description (cached) | Current situation | Top memories by score (below) |
| Claude Code | CLAUDE.md + rules (+ capped auto memory) | Session messages | Files via tools; path-scoped rules on demand |
| Anthropic agents | System + selected memory files developer injects or model reads | Messages until compaction | Memory tool `view`; tool results |

**MemGPT queue manager** (paper §2.2) is the clearest overflow policy:

- At **warning token count** (~70% window): inject a **memory-pressure system message** so the model can copy important FIFO content into working context or archival **before** loss.
- At **flush token count**: evict a chunk of the FIFO, rebuild recursive summary from (old summary + evicted), keep evicted rows only in recall storage.

**Generative Agents retrieval** (paper §4.1): score each memory as  
\(\mathrm{score} = \alpha_r\cdot\mathrm{recency} + \alpha_i\cdot\mathrm{importance} + \alpha_v\cdot\mathrm{relevance}\)  
with all \(\alpha = 1\) after min-max normalization. Recency = exponential decay on last access (decay 0.995 per sandbox hour). Importance = LLM 1–10 poignancy at **write time**. Relevance = embedding cosine to the query. Take top-scoring rows that fit the window.

**Anthropic context engineering**: pre-load only stable instruction files; give agents identifiers (paths, queries) and tools to pull detail; progressive disclosure beats stuffing. Compaction keeps last few files / recent tail depending on product; API compaction replaces pre-compaction blocks with summary ([eng post](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction)).

### NQ Context Assembly implications

Standing pin order (**Dossiers + Player Sheet first, then recent messages**) matches the MemGPT/Letta/Claude-Code “core before tail” pattern. Sharpenings from sources:

1. **Hard pins (never drop first):** GM system/seed voice, Player Sheet, *currently relevant* Dossiers (not necessarily all Dossiers ever written).
2. **Soft pins:** last \(N\) Turns of transcript; optional rolling summary of Turns older than \(N\) (MemGPT recursive summary).
3. **On-demand inject:** other Dossiers by name/tag match to the player’s latest act; Episodic hits by recency×importance×relevance (or cheaper keyword/tag until embeddings exist).
4. **Budget pressure order (drop/summarize first → last):** bulky tool/debug noise (if any) → old raw Turns (replace with summary) → low-relevance Episodic → low-relevance Dossiers → **never** Player Sheet / critical Dossiers / system voice.
5. **Do not** treat “fit the whole Campaign in context” as a goal; sources uniformly reject that (context rot, quadratic attention — Anthropic eng post; MemGPT intro).

---

## 4. Write paths (how memory gets authored)

### Pattern A — Self-directed tools (MemGPT / Anthropic memory tool)

Model emits function calls: edit working memory, insert archival, search, paginate. Runtime executes, returns results; optional **heartbeat** chaining for multi-step memory ops before yielding to the user (MemGPT §2.3–2.4). Anthropic memory tool is the same shape, client-implemented ([Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).

### Pattern B — Structured side-channel in the same completion (NQ standing choice)

NQ already chose **same GM model, structured Side-channel** rather than a mandatory separate writer pass. Closest primary analogues:

- MemGPT still uses **one** processor: completion tokens are parsed as function calls *or* user-facing content; memory ops are not a second model.
- GA writes observations continuously from the environment loop; reflections/plans are extra same-model prompts on a schedule — separate *calls*, same model family.
- Letta agent edits MemFS via normal agent tools in-band; **dreaming** is an optional **background** subagent pass for consolidation ([Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)).

**Design signal:** side-channel ops should be **explicit, schema-checked, and applied by the runtime** (MemGPT function executor validates args and feeds errors back). Do not rely on prose alone to update Dossiers.

### Pattern C — Pressure-triggered and idle consolidation

| Trigger | Source | Behavior |
| --- | --- | --- |
| Context warning before eviction | MemGPT | Model told to spill FIFO → working/archival |
| Importance sum threshold | Generative Agents | Reflect when recent importance scores sum > 150 (~2–3×/day in their sandbox) |
| After N user messages or on compact | Letta dreaming | Background subagent consolidates lessons into MemFS |
| On compact / session boundary | Anthropic guidance | Write durable notes **out** of the window; compaction is lossy |

**NQ signal:** Side-channel writes on **every Turn** for clear entity/fact deltas; plus a **Campaign-level compaction/reflection** job (could still be same model, not live player path) when Episodic grows or context budget tightens — graduation into Dossiers, merge duplicates, rewrite summaries. Idle “dreaming” is optional polish, not required for v1 correctness.

### Pattern D — Human-pinned vs model-written

Claude Code’s split is useful product language ([Memory docs](https://code.claude.com/docs/en/memory)):

- Human-authored stable instructions (seed GM voice, house rules packaging) ≈ CLAUDE.md.
- Model-authored evolving notes (Dossiers, Episodic, auto memory) ≈ auto memory / MemFS edits.

Keep seed content **replaceable packaging**, not mixed indistinguishably into model-mutable blobs without provenance.

---

## 5. Compaction vs durable memory (do not conflate)

From Anthropic docs + eng post and MemGPT queue flush:

| | **Durable memory** (Dossier / Episodic / MemFS / memory files) | **Compaction / FIFO summary** |
| --- | --- | --- |
| Purpose | Facts that must survive sessions | Keep *current* inference under the window |
| Lifetime | Campaign lifetime (until edited) | Until next compact / superseded summary |
| Fidelity | Curated; should be editable/auditable | Lossy by design |
| Write time | When something should stay true | When token threshold hits |
| Failure if misused as the other | Context bloat if everything “durable” | Silent amnesia if only compacted |

**Rule for NQ:** apply Side-channel Dossier/Episodic ops **before or as** old Turns are summarized away. A transcript summary is not a Dossier.

MemGPT’s two-phase pressure (warn → then flush) is worth copying so the model gets a chance to emit memory ops while the raw Turns are still visible.

---

## 6. Retrieval policy details worth stealing

1. **Write-time importance** (GA): score poignancy when the Episodic row is created; avoids re-scoring the whole log every Turn. Use later for retrieval and for “when to reflect/graduate.”
2. **Recency decay on access** (GA): touching a memory boosts it — if a Dossier is pinned or retrieved, bump its recency so it stays easy to re-select.
3. **Relevance to current situation** (GA embeddings; MemGPT archival cosine; Letta file search): query from latest player act + scene entities, not from the full Campaign.
4. **Pagination** (MemGPT): retrieval APIs must be token-aware so one search cannot blow the window.
5. **Named addressing** (Letta paths, Anthropic `/memories/...`, Dossier ids): entity state should be fetchable by stable id/name, not only by semantic similarity — NQ’s “no vector-only primary memory” standing choice.
6. **Evidence pointers** (GA reflections cite supporting memory ids): optional but valuable for debugging bad Dossier updates.

---

## 7. Failure modes called out in primaries

Carry these into testing notes for memory apply + Context Assembly:

- **Retrieval miss** — fact exists in store but not surfaced (GA eval: common failure; MemGPT may stop paging early).
- **Fabrication / embellishment** — model invents memory content (GA).
- **Stale entity state** — working context / Dossier not updated when world changed (MemGPT depends on self-edits firing).
- **Overfull always-on core** — working context / `system/` / too many pinned Dossiers crowd out recent Turns (Letta `/doctor` exists to audit this).
- **Compaction amnesia** — important detail only lived in raw Turns and died in summary (Anthropic: store exact values outside conversation).
- **Contradictory writes** — duplicate or conflicting Dossier rows (all systems; needs identity/merge policy — open NQ fog item).
- **Side-channel / tool parse failure** — MemGPT feeds validator errors back into context; NQ should define apply semantics for malformed ops (open fog item).

---

## 8. Condensed pattern checklist for NQ design

Use when writing `spec.md` / ADRs for memory + Context Assembly:

1. **Two stores minimum:** named updatable **Dossiers** (+ Player Sheet) and append-only **Episodic** log; full transcript is a third audit/recall store, not the reasoning substrate.
2. **Assembly recipe per Turn:**  
   `system/seed + Player Sheet + selected Dossiers + (Episodic hits) + rolling summary? + recent Turns + player input`  
   under a measured token budget.
3. **Selection:** prefer **id/name/scene graph** for Dossiers; score Episodic with **recency × importance × relevance** (importance at write).
4. **Pin priority under pressure:** Player Sheet + must-keep Dossiers → recent Turns → retrieved Episodic/other Dossiers → summaries replace raw history before pins drop.
5. **Writes:** same-model **structured Side-channel** each Turn; runtime validate/apply; optional later consolidation pass for graduation/merge (GA reflection / Letta dreaming).
6. **Pre-eviction warning:** when approaching budget, either force a memory-ops-friendly prompt or run assembly so the model still sees rows it should promote (MemGPT warn-then-flush).
7. **Compaction ≠ memory:** summarizing old Turns never replaces Dossier fields.
8. **Bounded always-on:** cap pinned Dossier count/bytes (Claude Code auto-memory cap; MemGPT fixed working context); spill overflow to retrieval tier.
9. **Provenance:** distinguish seed/human pins from model-written memory for edit/debug.
10. **Provider-agnostic:** tiers and pin policy live in Context Assembly; Provider only completes the assembled prompt (Grok now, local Bonsai later).

---

## 9. Explicit non-goals from sources (for scope control)

- Training-time weight updates as “memory” — all cited systems are **external state + prompt** (MemGPT conclusion; Reflexion-style verbal RL is optional later).
- Pure vector RAG over free text as the only memory — contradicted by MemGPT working context, Letta `system/` pins, Claude Code CLAUDE.md, NQ standing choice.
- Unlimited context as the strategy — rejected by MemGPT motivation and Anthropic context-rot discussion.
- Multi-agent society simulation complexity (GA full planning stack) — useful retrieval/reflection ideas only; NQ is one GM + one player Campaign, not 25 NPCs with daily plans.
