# Campaign git history

Research note for ticket [Campaign history via git](../../.scratch/nq-play-authoring/issues/05-campaign-history-via-git.md).  
Primary sources, inspected 2026-08-15. Does **not** pick the product default (later [Rewind after history](../../.scratch/nq-play-authoring/issues/06-rewind-after-history.md)).

- Git CLI man pages on this machine (`git version 2.55.0`) and [git-scm.com](https://git-scm.com/docs): [git-init](https://git-scm.com/docs/git-init), [git-add](https://git-scm.com/docs/git-add), [git-commit](https://git-scm.com/docs/git-commit), [git-log](https://git-scm.com/docs/git-log), [git-checkout](https://git-scm.com/docs/git-checkout), [git-reset](https://git-scm.com/docs/git-reset), [git-revert](https://git-scm.com/docs/git-revert), [git-restore](https://git-scm.com/docs/git-restore), [gitignore](https://git-scm.com/docs/gitignore), [gitglossary](https://git-scm.com/docs/gitglossary), [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout), [git-update-ref](https://git-scm.com/docs/git-update-ref), [git-checkout-index](https://git-scm.com/docs/git-checkout-index), [api-lockfile](https://git-scm.com/docs/api-lockfile), [git COPYING](https://raw.githubusercontent.com/git/git/master/COPYING)
- isomorphic-git [site](https://isomorphic-git.org/), [quickstart](https://isomorphic-git.org/docs/en/quickstart), [alphabetic index](https://isomorphic-git.org/docs/en/alphabetic), [init](https://isomorphic-git.org/docs/en/init), [add](https://isomorphic-git.org/docs/en/add), [commit](https://isomorphic-git.org/docs/en/commit), [log](https://isomorphic-git.org/docs/en/log), [checkout](https://isomorphic-git.org/docs/en/checkout), [statusMatrix](https://isomorphic-git.org/docs/en/statusMatrix), [resetIndex](https://isomorphic-git.org/docs/en/resetIndex), [isIgnored](https://isomorphic-git.org/docs/en/isIgnored), [writeRef](https://isomorphic-git.org/docs/en/writeRef), [fs](https://isomorphic-git.org/docs/en/fs), [fs (next)](https://isomorphic-git.org/docs/en/next/fs), [cache](https://isomorphic-git.org/docs/en/cache); GitHub [isomorphic-git/isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) README + [LICENSE.md](https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/LICENSE.md) (MIT); latest tag **v1.41.4** (2026-08-13)
- This repo: [`CONTEXT.md`](../../CONTEXT.md), [ADR-0003](../adr/0003-campaign-folder-memory-contract.md), [`docs/spec.md`](../spec.md) §4–5 and §10; fixture sizes under `tests/eval/fixtures/dirty-midgame/`

---

## Summary (facts only)

| Topic | Fact | Source |
| --- | --- | --- |
| **Can a Campaign folder be a git working tree?** | Yes. Git stores file contents as uninterpreted byte blobs. Markdown and jsonl are ordinary files. `git init` in an existing directory is the documented “start a repo for an existing codebase” path; no remote is required. | [git-commit DISCUSSION](https://git-scm.com/docs/git-commit) (“blob objects are uninterpreted sequences of bytes”); [git-init EXAMPLES](https://git-scm.com/docs/git-init); [gitglossary *working tree*](https://git-scm.com/docs/gitglossary) |
| **CLI verbs** | `init`, `add`, `commit`, `log`, `checkout`, `reset`, `revert` all exist and operate on that working tree. | man pages linked above |
| **isomorphic-git verbs** | `init`, `add`, `commit`, `log`, `checkout`, `statusMatrix` exist. `resetIndex` only resets the **index**, not the working tree. **No** `reset --hard` and **no** `revert`. Branch tip can be moved with `writeRef`. | [alphabetic index](https://isomorphic-git.org/docs/en/alphabetic); [resetIndex](https://isomorphic-git.org/docs/en/resetIndex); [writeRef](https://isomorphic-git.org/docs/en/writeRef) |
| **Local only** | `git init` creates `$GIT_DIR` (default `./.git`) with `objects` / `refs`. Nothing in those commands talks to GitHub. isomorphic-git writes the same `.git` layout. | [git-init](https://git-scm.com/docs/git-init); isomorphic-git README (“modifying files in a `.git` directory”) |
| **Bun + isomorphic-git** | Library takes an `fs` plugin. On disk, official docs say pass Node’s `fs`. Next-docs compatibility table lists **Bun ✅** for LightningFS / MemoryBackend / ZenFS InMemory. LightningFS is the **browser / IndexedDB** emulator, not the Campaign-folder path. | [fs](https://isomorphic-git.org/docs/en/fs); [fs (next)](https://isomorphic-git.org/docs/en/next/fs) |
| **“Go back and keep playing”** | Official split: `revert` = new undo commits; `restore` = files only, no branch move; `reset` = move branch tip (optional working-tree overwrite). `checkout <commit>` detaches HEAD at that tree. Glossary *rewind* = assign the head to an earlier revision. | [git(1) “Reset, restore and revert”](https://git-scm.com/docs/git#_reset_restore_and_revert); [git-checkout DETACHED HEAD](https://git-scm.com/docs/git-checkout); [gitglossary *rewind*](https://git-scm.com/docs/gitglossary) |
| **License** | git CLI: **GPL-2.0-only** (project COPYING). isomorphic-git: **MIT**. | [git COPYING](https://raw.githubusercontent.com/git/git/master/COPYING); [LICENSE.md](https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/LICENSE.md) |
| **Other Bun-fit git impl** | None first-class. isomorphic-git README lists js-git / es-git as similar; those are not documented Bun-on-disk Campaign targets. CLI wrappers are not a git implementation. | isomorphic-git README “Similar projects” |

---

## 1. Campaign paths this note names

Prescribed tree from [ADR-0003](../adr/0003-campaign-folder-memory-contract.md) and [spec §4](../spec.md):

```
<campaign>/
  campaign.yaml          # NQ identity meta only
  seed.md                # GM voice + premise (immutable by convention)
  player_sheet.md        # sole runtime PC SoT
  world-building.md      # factions / events / setting
  dossiers/<slug>.md     # recurring person | place | other
  story-beats.md         # Hygiene-authored chronicle
  quest-log.md           # Hygiene-authored open branches
  transcript.jsonl       # player-facing prose SoT (NQ-owned appends)
  .nq/sessions/          # OMP SessionManager journal (private)
  .nq/play_state.json    # NQ Play Loop / hygiene bookkeeping
```

[Spec §5](../spec.md): Turn transcript writes are **live-through** (no Turn rollback). FAIL keeps the accepted player row. Play has no Campaign-memory write tools; Hygiene writes memory after successful Turns. OMP `.nq/sessions/*` may be partial; Campaign memory plus successful transcript rows win. [Spec §10](../spec.md): `play` / `serve` / `turn` never share a process; **no lock file** (last writer wins).

---

## 2. git CLI against a directory of markdown + jsonl

### 2.1 Init + add + commit + log + checkout

[git-init](https://git-scm.com/docs/git-init) creates an empty repository: a `.git` directory with `objects`, `refs/heads`, `refs/tags`, and an initial branch with no commits. Running `git init` in an existing repository is documented as safe (does not overwrite existing objects). The documented “existing codebase” sequence is:

```
$ cd /path/to/my/codebase
$ git init
$ git add .
$ git commit
```

That is exactly “put this Campaign folder under revision control.” Optional `<directory>` argument runs the command inside that path. `--initial-branch=<name>` sets the first branch; otherwise `init.defaultBranch` or the built-in default (`master`, documented to become `main` in Git 3.0).

No remotes, fetch, or GitHub account appear in `init` / `add` / `commit` / `log` / `checkout`. A Campaign repo can stay local for its whole life.

[git-add](https://git-scm.com/docs/git-add) copies working-tree contents into the **index** (staging area). `git add` does not add ignored files unless `--force`. `git add -A` / `--all` stages additions, modifications, and removals to match the working tree.

[git-commit](https://git-scm.com/docs/git-commit) records the index as a new commit, child of HEAD, and advances the current branch (or advances detached HEAD). Blob contents are uninterpreted bytes — `.md` and `.jsonl` are not special. Author/committer come from `user.name` / `user.email` or `GIT_AUTHOR_*` / `GIT_COMMITTER_*`. `-m` supplies the message without an editor (needed for a non-interactive Play Loop). `--allow-empty` is the documented escape if the tree did not change.

[git-log](https://git-scm.com/docs/git-log) walks parent links from a revision range (default `HEAD`) in reverse chronological order. `-n` / `--max-count` limits the listing. Pathspecs restrict to commits that touch those files.

[git-checkout](https://git-scm.com/docs/git-checkout) has two modes:

1. **Switch branches / commits** — `git checkout <branch>` or `git checkout <commit>`. Updates the working tree to that tree. Fails if uncommitted changes would be overwritten (unless `-f` / `--force`).
2. **Restore paths** — `git checkout <tree-ish> -- <pathspec>` replaces those files from the given tree and stages them.

Glossary [checkout](https://git-scm.com/docs/gitglossary): “updating all or part of the working tree with a tree object or blob from the object database, and updating the index and HEAD if the whole working tree has been pointed at a new branch.”

[git-checkout DETACHED HEAD](https://git-scm.com/docs/git-checkout): `git checkout <commit>` when `<commit>` is not a branch name points HEAD at that commit. Further `git commit`s create new history reachable only from HEAD until a branch/tag is created. Leaving detached HEAD without a ref lets those commits become unreachable and eligible for GC.

### 2.2 Checkout vs reset vs revert (rewind + keep playing)

Official [git(1) “Reset, restore and revert”](https://git-scm.com/docs/git#_reset_restore_and_revert):

| Command | What it does | History | Working tree |
| --- | --- | --- | --- |
| `git revert <commit>` | New commit(s) that reverse the **patch** of named commit(s). Requires a **clean** working tree. | History grows forward | Becomes the reverse of those patches, not an arbitrary past snapshot unless every later commit is reverted in order |
| `git restore` | Restore files from index or another commit. **Does not update the branch.** | Unchanged | Selected paths |
| `git reset [<mode>] <commit>` | Point the current branch (`HEAD`) at `<commit>`. Mode chooses whether index / working tree follow. | Branch tip moves (**rewind** in glossary terms) | `--hard` makes the working tree match `<commit>` and “may overwrite untracked files”; tracked paths not in `<commit>` are removed |

[git-revert](https://git-scm.com/docs/git-revert) explicitly: if you want to throw away uncommitted changes, see `git reset --hard`; if you want files as they were in another commit, see `git restore --source`. Revert is the wrong primitive for “that save point’s tree.”

[git-reset `--hard`](https://git-scm.com/docs/git-reset): “Overwrite all files and directories with the version from `<commit>`.” Example “Undo commits permanently”: `git reset --hard HEAD~3`. After that, new commits continue on the same branch from the older tip. Commits that fell off the branch remain in the reflog until GC.

[git-checkout `<commit>`](https://git-scm.com/docs/git-checkout) (no `-b`): same working-tree result as landing on that commit, but **does not move the old branch tip**. The previous line of play stays on the original branch. Keep-playing from there without losing the new commits requires creating a ref (`git checkout -b <new-branch>` is the documented “create branch and check it out” form).

[gitglossary *rewind*](https://git-scm.com/docs/gitglossary): “To throw away part of the development, i.e. to assign the head to an earlier revision.” That definition matches `reset` of the current branch, not `revert`, and not a detached checkout that leaves the old branch where it was.

None of these pages pick which of those NQ should expose as “rewind.” They only define the primitives.

### 2.3 Ignore rules (what git will and will not rewind)

[gitignore](https://git-scm.com/docs/gitignore): patterns exclude **untracked** paths from `git add` / `git status`. **Already-tracked files are not affected.** To stop tracking a tracked file: `git rm --cached` then add a pattern.

Sources, highest precedence first: command-line patterns; `.gitignore` in the path’s directory or parents; `$GIT_COMMON_DIR/info/exclude`; `core.excludesFile`.

Git’s own lock files live **inside** `$GIT_DIR` (see §6). They are not Campaign working-tree paths.

Classification by **this repo’s file roles** (consequences of tracking vs ignoring — not a product pick):

| Path | Role (ADR-0003 / spec §4–5) | If **tracked** | If **ignored** |
| --- | --- | --- | --- |
| `player_sheet.md` | Sole runtime PC SoT; whole file pinned | Checkout restores past sheet | Rewind cannot restore PC facts |
| `world-building.md` | Factions / events / setting | Checkout restores past world | Same |
| `dossiers/<slug>.md` | Recurring entity SoT; slug is durable id; never delete in v1 | Checkout restores / removes dossier files that exist in that commit | Same |
| `story-beats.md` | Hygiene-authored chronicle; v1 append-only | Checkout restores past beats | Same |
| `quest-log.md` | Hygiene-authored open bullets (deletes when done) | Checkout restores past open list | Same |
| `transcript.jsonl` | Player-facing prose SoT; NQ appends `{ts, role, text}` | Checkout restores past story | Story text stays at “now”; Inspect/play tail would not match restored memory |
| `seed.md` | Premise / voice; immutable **by convention** | Tracking is a no-op unless someone writes it | A convention-breaking write would survive checkout |
| `campaign.yaml` | NQ identity: `id`, `created_at`, `schema_version`, `name` | Checkout can rewrite identity fields | Identity stays put across rewind |
| `.nq/sessions/` | OMP SessionManager journal; **private**; **loses to Campaign files** | Checkout restores a journal that may contradict the restored tree and `continueRecent` | Journal stays current; spec already says Campaign files win |
| `.nq/play_state.json` | NQ-only `success_turn_count` / hygiene cursors | Checkout restores old counters that need not match restored transcript or a replaced session | Bookkeeping stays current; can desync from a restored transcript |
| Git `$GIT_DIR/*.lock` | Git writer locks, not Campaign files | Not in the working tree | N/A |

The ticket names `.nq/sessions/` (OMP journal) and locks as ignore candidates. Spec §10 has **no** Campaign lock file to ignore.

A Campaign-root `.gitignore` is itself a working-tree file; if committed, it is part of history.

---

## 3. isomorphic-git

### 3.1 What it is

[README](https://github.com/isomorphic-git/isomorphic-git): pure JavaScript reimplementation of git for Node and browsers. “100% interoperability with the canonical git implementation” by modifying a `.git` directory the same way git does. No native C++ addon. `isogit` CLI is documented as a thin shell, “isn’t really meant as a `git` CLI replacement.”

Latest GitHub release inspected: **v1.41.4** (2026-08-13). `package.json` `license`: MIT; `engines.node`: `>=14.17`. No `engines.bun`.

### 3.2 Commands that exist (and do not)

Confirmed on the [alphabetic index](https://isomorphic-git.org/docs/en/alphabetic) and individual pages:

| Function | Role |
| --- | --- |
| [`init`](https://isomorphic-git.org/docs/en/init) | `await git.init({ fs, dir })`. `defaultBranch` default `'master'`. Optional `bare`, `gitdir`. |
| [`add`](https://isomorphic-git.org/docs/en/add) | Stage `filepath` (string or array). `force: true` = `git add --force` (ignore `.gitignore`). |
| [`commit`](https://isomorphic-git.org/docs/en/commit) | Returns new commit SHA-1. Requires `message` unless `amend`. Author defaults to `user.name` / `user.email` config. |
| [`log`](https://isomorphic-git.org/docs/en/log) | Array of `{ oid, commit, payload }`. `ref` default `'HEAD'`. Optional `depth`, `since`. |
| [`checkout`](https://isomorphic-git.org/docs/en/checkout) | Checkout a `ref` (default `'HEAD'`). `force` overwrites local changes. `filepaths` can restore from index if `ref` omitted. `noCheckout` updates HEAD only; `noUpdateHead` updates the working tree only. `dryRun` simulates. |
| [`statusMatrix`](https://isomorphic-git.org/docs/en/statusMatrix) | One pass over HEAD / workdir / stage. Example filter: `f => f.endsWith('.json') \|\| f.endsWith('.md')`. |
| [`isIgnored`](https://isomorphic-git.org/docs/en/isIgnored) | Tests `.gitignore` or `.git/exclude`. |
| [`resetIndex`](https://isomorphic-git.org/docs/en/resetIndex) | Reset **index** entry from `ref` (default HEAD). **“this does NOT modify the file in the working directory.”** |
| [`writeRef`](https://isomorphic-git.org/docs/en/writeRef) | Write a ref or symbolic ref (can move a branch tip). |

**Absent** from the command list: `reset` (`--hard` / `--soft` / `--mixed`), `revert`, `restore`. A hard rewind of both branch and tree is not one function; it is `writeRef` (move tip) plus `checkout({ ref, force: true })`, or checkout of a commit (detached HEAD semantics as in git).

### 3.3 `fs`: node:fs vs lightning-fs vs Bun

[fs docs](https://isomorphic-git.org/docs/en/fs):

- Every file-touching call takes an `fs` client.
- **Node / disk:** “you can just use the native `fs` module” (`require('fs')` / `node:fs`).
- **Browser:** [LightningFS](https://github.com/isomorphic-git/lightning-fs) (IndexedDB-backed `fs` emulator, same author) or ZenFS / BrowserFS. README warning: LightningFS “may apply file operations out of order” and can corrupt a repo on crash; mitigate with `fs.flush()`.
- If `fs.promises` is enumerable, isomorphic-git uses the promise API **exclusively**.

[fs (next) compatibility table](https://isomorphic-git.org/docs/en/next/fs):

| Runtime | LightningFS (default) | LightningFS + MemoryBackend | ZenFS InMemory |
| --- | --- | --- | --- |
| Node.js | ❌ (no IndexedDB; **use native `fs`**) | ✅ | ✅ |
| Browser | ✅ | ✅ | ✅ |
| Bun | ✅ | ✅ | ✅ |

That table is about **LightningFS/ZenFS in-memory / IndexedDB backends**. A Campaign folder is a real directory of markdown + jsonl. The documented disk path is Node’s `fs`. Bun’s Node-compat layer is what would supply `node:fs` for that path (`package.json` in this repo: `"engines": { "bun": ">=1.3.0" }`).

LightningFS is the wrong plugin for rewriting `player_sheet.md` on disk next to `.nq/`.

Historical caveat (not current docs): [oven-sh/bun#7818](https://github.com/oven-sh/bun/issues/7818) (2023-12-24) reported isomorphic-git failing on Bun because it inspected `Error` shape / `fs.promises`. The next-docs table now lists Bun as supported; that issue is not a current product constraint.

### 3.4 Size / speed (what the docs actually say)

- isomorphic-git [cache](https://isomorphic-git.org/docs/en/cache): calling `status` per file on the isomorphic-git repo itself took **>2 minutes** on a 2018 MBP; `statusMatrix` did the same work in **843 ms**. Shared `cache` object is required to avoid re-parsing packfiles. Docs warn of a memory leak if a long-lived cache is never dropped.
- `add({ parallel: true })` trades memory for time.
- `checkout({ nonBlocking: true, batchSize: 100 })` is documented for browsers (avoid blocking the JS thread), not as a Campaign-folder speed claim.
- Bundlewatch cap on the UMD build: **100 kb** (`package.json` `bundlewatch`). That is library size, not repo size.
- Git [checkout.workers](https://git-scm.com/docs/git-checkout) / `checkout.thresholdForParallelism` (default 100 files): parallel checkout “usually delivers better performance for repositories located on SSDs”; default sequential is often better on spinning disks. A Campaign tree is a handful of markdown files plus one growing jsonl — well below that threshold.

This repo’s midgame overlay `tests/eval/fixtures/dirty-midgame/` (measured 2026-08-15) is **~5.5 KB** total; `transcript.jsonl` is **3652 bytes / 19 lines**. Spec §8 keep-tail is **40k tokens** of player-facing transcript (POC estimator chars/4 ⇒ on the order of **160 KB** of jsonl in the rebuilt session, not a bound on the on-disk file). Official git/isomorphic-git docs do **not** publish timings for a Campaign-sized tree. They do say git stores snapshots as content-addressed blobs + trees; unchanged files are not re-stored. Growing `transcript.jsonl` is the only path that scales with play length.

---

## 4. Other libraries

isomorphic-git README “Similar projects”: [js-git](https://github.com/creationix/js-git), [es-git](https://github.com/es-git/es-git). Neither is documented as a Bun-first, disk-working-tree `init` / `add` / `commit` / `log` / `checkout` stack.

Not first-class for this ticket (not a git implementation NQ would own on Bun without a native/wasm stack or a `git` spawn):

- **simple-git** and relatives — spawn the git CLI.
- **nodegit** — native libgit2 bindings.
- **wasm-git** — libgit2 compiled to wasm; not a documented Bun Campaign-folder library.
- **libgit2** — C library (GPLv2 with linking exception); not JS.

Skip: no other first-class Bun-fit library that is actually git (not a zip snapshot) showed up in primary docs.

---

## 5. Checkout while another process has files open

**Best-effort.** No git or isomorphic-git page says “safe to checkout while another process has these files open.”

What the primary sources do say:

- [Spec §5](../spec.md): during **Turning**, NQ live-appends the player transcript row. Campaign-memory writes occur only during Hygiene. There is no Turn-level rollback.
- [Spec §10](../spec.md): `play`, `serve`, and `turn` **never share a process**. One Campaign at a time per play/serve process. **No lock file** — last writer wins.
- [git-checkout](https://git-scm.com/docs/git-checkout): refuses to switch if uncommitted changes would be overwritten, unless `-f`. `-f` “throw[s] away local changes and any untracked files or directories that are in the way.” That is about the git index vs working tree, not about foreign file descriptors.
- [git-checkout-index](https://git-scm.com/docs/git-checkout-index): copies index → working tree; default **does not overwrite** existing files; `-f` forces overwrite.
- [api-lockfile](https://git-scm.com/docs/api-lockfile): Git’s locks (`<filename>.lock`, including `$GIT_DIR/index.lock`) are for **Git writers**. Created `O_CREAT|O_EXCL`, committed with `rename(2)`. “Lockfiles only block other writers. Readers do not block, but they are guaranteed to see either the old contents of the file or the new contents” *if* the filesystem’s `rename` is atomic. That guarantee is about Git’s own lock+rename of `$GIT_DIR` files, **not** about an agent `write`/`edit` racing `checkout` on `player_sheet.md`.
- [git-update-ref](https://git-scm.com/docs/git-update-ref): ref updates lock refs; a concurrent reader “may still see a subset of the modifications.”
- [git-status BACKGROUND REFRESH](https://git-scm.com/docs/git-status): a background `git status` that writes the index can fail other git processes on the lock; scripts should use `git --no-optional-locks status`.
- isomorphic-git `checkout({ force: true })` “conflicts will be ignored and files will be overwritten regardless of local changes.” No mention of open handles.

Implication for a Play Loop (fact, not a pick): a checkout that rewrites `transcript.jsonl` during Turning races the live transcript append; a checkout during Hygiene races Campaign-memory writes. Git will not serialize those. Two git operations at once contend on `$GIT_DIR/*.lock`. Two NQ processes on one Campaign already have last-writer-wins with no Campaign lock.

On Unix, replacing a path typically leaves a previously opened fd attached to the old inode; the other process does not see the checked-out bytes until it reopens. Official git docs do not document that OS behavior; treat it as a reason not to claim “safe.”

---

## 6. Licenses

| Artifact | License | Notes |
| --- | --- | --- |
| **git** (the program this machine runs) | **GPL-2.0-only** | [COPYING](https://raw.githubusercontent.com/git/git/master/COPYING): “the only valid version of the GPL as far as this project is concerned is _this_ particular version (ie v2, not v2.2 or v3.x).” Running the binary is “the act of running the Program” (GPL §0) and is not restricted. Linking git source into NQ would be a different question; this ticket is CLI spawn. |
| **isomorphic-git** | **MIT** | [LICENSE.md](https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/LICENSE.md); `package.json` `"license": "MIT"`. |

---

## 7. Not decided here

These are product questions for [Rewind after history](../../.scratch/nq-play-authoring/issues/06-rewind-after-history.md):

- CLI spawn vs isomorphic-git (or both).
- Whether rewind is `reset --hard`, detached `checkout`, or `checkout -b`.
- Which Campaign paths are committed vs gitignored.
- When NQ creates commits (Turn SUCCESS, hygiene, compact, …).
- What happens to the OMP session after a tree rewind.
