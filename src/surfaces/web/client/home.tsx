import { useEffect, useState } from "preact/hooks";
import type { HomeView } from "../api.ts";
import type { HomeSettings } from "../../../home/settings.ts";
import type { LocalModelSelection } from "../../../home/types.ts";
import { visibleHomeChoices } from "../../../home/model_filter.ts";
import { Fleuron } from "./ornament.tsx";
import { wasBookOpened } from "./visits.ts";
import { LocalModelPanel } from "./home/local_model_panel.tsx";
import { AlmanacSheet, LocalLoadingPanel } from "./home/panels.tsx";
import { SettingsPanel } from "./home/settings_panel.tsx";


export type HomeViewSnapshot = HomeView;

export type HomeAppProps = {
  snap: HomeViewSnapshot;
  titleDraft: string;
  promptDraft: string;
  moreOpen: boolean;
  selectedPack?: string;
  onSignIn: (provider: string) => void;
  onPromptDraft: (text: string) => void;
  onPrompt: (text: string) => void;
  onPickModel: (name: string) => void;
  onPickReasoning: (name: string) => void;
  onConfigureLocal: (selection: LocalModelSelection) => void;
  /** Resolves false when the download failed; `notice` then says why. */
  onDownloadEngine?: (backend: string) => Promise<boolean>;
  onOpenCampaign: (id: string) => void;
  onDeleteCampaign?: (id: string) => Promise<boolean>;
  onSelectPack: (id: string, name: string) => void;
  onTitle: (title: string) => void;
  onBirth: () => void;
  onToggleMore: () => void;
  onSaveSettings: (settings: HomeSettings) => Promise<boolean>;
  onCancelLogin?: () => void;
  notice?: string;
};

export function HomeApp(props: HomeAppProps) {
  const { snap } = props;
  const awaitingPrompt = snap.login.phase === "awaiting_prompt";
  const awaitingModel = snap.login.phase === "awaiting_model";
  const awaitingReasoning = snap.login.phase === "awaiting_reasoning";
  const awaitingLocal = snap.login.phase === "awaiting_local";
  const loadingLocal =
    snap.login.phase === "working" &&
    (snap.signedIn?.provider === "This computer" ||
      snap.settings.model.startsWith("llama.cpp/"));
  const picking =
    awaitingPrompt ||
    awaitingModel ||
    awaitingLocal ||
    awaitingReasoning ||
    snap.login.phase === "working" ||
    snap.login.phase === "awaiting_browser";
  const [modelQuery, setModelQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [almanacOpen, setAlmanacOpen] = useState(false);
  const [campaignToDelete, setCampaignToDelete] = useState<
    { id: string; name: string } | undefined
  >();
  const [deletingCampaign, setDeletingCampaign] = useState(false);
  const modalOpen =
    settingsOpen ||
    almanacOpen ||
    awaitingLocal ||
    loadingLocal ||
    Boolean(campaignToDelete);
  useEffect(() => {
    if (!modalOpen) return;
    const background = document.querySelectorAll<HTMLElement>(
      ".home > :not(.home-settings-backdrop)",
    );
    background.forEach((element) => {
      element.inert = true;
    });
    const focusFrame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-modal-first]")?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (campaignToDelete && !deletingCampaign) {
        setCampaignToDelete(undefined);
      } else if (settingsOpen) {
        setSettingsOpen(false);
      } else if (almanacOpen) {
        setAlmanacOpen(false);
      } else if (awaitingLocal || loadingLocal) {
        props.onCancelLogin?.();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      background.forEach((element) => {
        element.inert = false;
      });
    };
  }, [
    modalOpen,
    settingsOpen,
    almanacOpen,
    awaitingLocal,
    loadingLocal,
    campaignToDelete,
    deletingCampaign,
  ]);
  useEffect(() => {
    if (!awaitingModel) setModelQuery("");
  }, [awaitingModel]);
  const modelView = visibleHomeChoices(snap.models ?? [], modelQuery);
  // Home opens the cover, unless the player is coming back from the book
  const [intro] = useState(() => (wasBookOpened() ? "returning" : "opening"));

  // the Almanac is about local models; it has nothing for a cloud account
  const localInstalled = snap.providers.featured.some(
    (p) => p.name === "This computer",
  );
  const connected =
    snap.providers.featured.some((p) => p.connected) ||
    snap.providers.more.some((p) => p.connected);

  return (
    <div class={`home is-${intro}`}>
      <div class="home-book">
        <div class="home-flip" aria-hidden="true">
          <div class="home-flip-face home-flip-front" />
          <div class="home-flip-face home-flip-back" />
        </div>
        <section
          class={`home-page home-verso${picking ? " is-picking" : ""}`}
          aria-label="Title page"
        >
          <nav class="home-corner" aria-label="Book">
            <button
              type="button"
              class="home-settings-button"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>
            {localInstalled ? (
              <button
                type="button"
                class="home-settings-button"
                aria-expanded={almanacOpen}
                onClick={() => setAlmanacOpen(true)}
              >
                Almanac
              </button>
            ) : null}
          </nav>
          <header class="home-head">
            <div class="home-frontispiece" aria-hidden="true">
              <img src="/ink/frontispiece.webp" alt="" />
            </div>
            <div class="home-headline">
              <h1>Neverending Quest</h1>
              <Fleuron class="home-fleuron" />
              <p class="home-tagline">
                A tale told turn by turn, with a Game Master who remembers.
              </p>
            </div>
            <p class={`home-signed${snap.signedIn ? " is-in" : ""}`}>
              {snap.signedIn ? (
                <>
                  <span class="home-signed-dot" aria-hidden="true" />
                  Signed in: {snap.signedIn.provider}
                  {snap.signedIn.model ? (
                    <code class="home-model" title={snap.signedIn.model}>
                      {snap.signedIn.model}
                    </code>
                  ) : null}
                </>
              ) : connected ? (
                "Choose which account the Game Master plays with."
              ) : (
                "Sign in to play."
              )}
            </p>
            {snap.login.phase !== "idle" && snap.login.message ? (
              <p
                class={`home-login ${snap.login.phase === "error" ? "err" : ""}`}
              >
                {snap.login.message}
              </p>
            ) : null}
            {props.notice && !campaignToDelete ? (
              <p class="home-login err">
                {props.notice}
              </p>
            ) : null}
          </header>
          {!snap.locked && snap.choosesGameMaster ? (
            <section class="home-section home-accounts">
              <h2>
                {picking && snap.signedIn
                  ? snap.signedIn.provider
                  : connected
                    ? "Accounts"
                    : "Sign in"}
              </h2>
              {picking ? (
                <div class="home-row">
                  {snap.signedIn ? (
                    <button type="button" class="on" disabled>
                      {snap.signedIn.provider}
                      <small>Selected</small>
                    </button>
                  ) : null}
                  {props.onCancelLogin ? (
                    <button type="button" onClick={props.onCancelLogin}>
                      Change
                    </button>
                  ) : null}
                </div>
              ) : (
                <>
                  <div class="home-row">
                    {snap.providers.featured.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        class={p.connected ? "on" : ""}
                        onClick={() => props.onSignIn(p.name)}
                      >
                        {p.name}
                        {p.connected ? <small>Connected</small> : null}
                      </button>
                    ))}
                    {snap.providers.more.length > 0 ? (
                      <button
                        type="button"
                        class="home-more"
                        aria-expanded={props.moreOpen}
                        onClick={props.onToggleMore}
                      >
                        More…
                      </button>
                    ) : null}
                  </div>
                  {props.moreOpen ? (
                    <div class="home-row more">
                      {snap.providers.more.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          class={p.connected ? "on" : ""}
                          onClick={() => props.onSignIn(p.name)}
                        >
                          {p.name}
                          {p.connected ? <small>Connected</small> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
              {awaitingPrompt ? (
                <form
                  class="home-prompt"
                  onSubmit={(e) => {
                    e.preventDefault();
                    props.onPrompt(props.promptDraft);
                  }}
                >
                  <input
                    value={props.promptDraft}
                    placeholder="Paste here"
                    onInput={(e) =>
                      props.onPromptDraft((e.target as HTMLInputElement).value)
                    }
                  />
                  <button type="submit">Continue</button>
                </form>
              ) : null}

              {awaitingModel && snap.models ? (
                <div class="home-models">
                  <label>
                    Find a model
                    <input
                      type="search"
                      value={modelQuery}
                      placeholder="GLM 5.2 free"
                      onInput={(ev) =>
                        setModelQuery(
                          (ev.currentTarget as HTMLInputElement).value,
                        )
                      }
                    />
                  </label>
                  {modelView.needQuery ? (
                    <p class="home-empty">
                      {modelView.total} models. Type to find one.
                    </p>
                  ) : modelView.shown.length === 0 ? (
                    <p class="home-empty">Nothing matches.</p>
                  ) : (
                    <div class="home-row home-model-list">
                      {modelView.shown.map((m) => (
                        <button
                          key={m.name}
                          type="button"
                          onClick={() => props.onPickModel(m.name)}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              {awaitingReasoning && snap.reasoning ? (
                <div class="home-row">
                  {snap.reasoning.map((level) => (
                    <button
                      key={level.name}
                      type="button"
                      onClick={() => props.onPickReasoning(level.name)}
                    >
                      {level.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </section>

        <section class="home-page home-recto" aria-label="Contents">
          <p class="home-contents-title" aria-hidden="true">
            Contents
          </p>
          <section class="home-section">
            <h2>Continue</h2>
            {snap.campaigns.length === 0 ? (
              <p class="home-empty">
                No Campaigns yet. Begin one below.
              </p>
            ) : (
              <ul class="home-list">
                {snap.campaigns.map((c, index) => (
                  <li
                    key={c.id}
                    class="home-campaign"
                    style={{ "--i": String(index) }}
                  >
                    <button
                      type="button"
                      class="home-campaign-open"
                      onClick={() => props.onOpenCampaign(c.id)}
                    >
                      <span class="toc-name">{c.name}</span>
                      <span class="toc-leader" aria-hidden="true" />
                    </button>
                    {props.onDeleteCampaign ? (
                      <button
                        type="button"
                        class="home-campaign-delete"
                        aria-label={`Delete ${c.name}`}
                        title={`Delete ${c.name}`}
                        onClick={() => setCampaignToDelete(c)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
                        </svg>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section class="home-section">
            <h2>New adventure</h2>
            <ol class="home-packs">
              {snap.packs.map((p, index) => {
                const on = props.selectedPack === p.id;
                return (
                  <li
                    key={p.id}
                    class={on ? "is-on" : ""}
                    style={{ "--i": String(index + snap.campaigns.length) }}
                  >
                    <button
                      type="button"
                      class={on ? "on" : ""}
                      aria-pressed={on}
                      onClick={() => props.onSelectPack(p.id, p.name)}
                    >
                      <span class="pack-numeral" aria-hidden="true">
                        {romanNumeral(index + 1)}
                      </span>
                      <strong>{p.name}</strong>
                      {p.description ? <span>{p.description}</span> : null}
                    </button>
                    {on ? (
                      <form
                        class="home-title"
                        onSubmit={(e) => {
                          e.preventDefault();
                          props.onBirth();
                        }}
                      >
                        <label>
                          Title
                          <input
                            value={props.titleDraft}
                            onInput={(e) =>
                              props.onTitle((e.target as HTMLInputElement).value)
                            }
                          />
                        </label>
                        <button type="submit">Begin</button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        </section>
      </div>

      {settingsOpen && !loadingLocal ? (
        <SettingsPanel
          settings={snap.settings}
          fixed={snap.fixedSettings ?? []}
          onClose={() => setSettingsOpen(false)}
          onSave={async (settings) => {
            const saved = await props.onSaveSettings(settings);
            if (saved) setSettingsOpen(false);
            return saved;
          }}
        />
      ) : null}

      {almanacOpen && !loadingLocal && !awaitingLocal ? (
        <AlmanacSheet onClose={() => setAlmanacOpen(false)} />
      ) : null}

      {campaignToDelete ? (
        <div class="home-settings-backdrop">
          <section
            class="home-settings home-delete"
            role="alertdialog"
            aria-modal="true"
            aria-busy={deletingCampaign}
            aria-labelledby="home-delete-title"
            aria-describedby="home-delete-warning"
          >
            <div class="home-settings-head">
              <div>
                <h2 id="home-delete-title">
                  Delete "{campaignToDelete.name}"?
                </h2>
                <p id="home-delete-warning">
                  This permanently deletes the entire Campaign folder from disk,
                  including its story, notes, and history. This cannot be
                  undone.
                </p>
              </div>
            </div>
            <div class="home-delete-actions">
              <button
                type="button"
                data-modal-first
                disabled={deletingCampaign}
                onClick={() => setCampaignToDelete(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="danger"
                disabled={deletingCampaign}
                onClick={async () => {
                  setDeletingCampaign(true);
                  const deleted =
                    (await props.onDeleteCampaign?.(campaignToDelete.id)) ??
                    false;
                  setDeletingCampaign(false);
                  if (deleted) setCampaignToDelete(undefined);
                }}
              >
                {deletingCampaign ? "Deleting…" : "Delete from disk"}
              </button>
            </div>
            {props.notice ? (
              <p class="home-delete-error" role="alert">
                {props.notice}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {loadingLocal ? (
        <LocalLoadingPanel
          message={snap.login.message}
          onCancel={() => props.onCancelLogin?.()}
        />
      ) : null}

      {awaitingLocal && snap.models ? (
        <LocalModelPanel
          models={snap.models}
          mmproj={snap.mmproj ?? []}
          gpus={snap.gpus ?? null}
          exl3xpu={snap.exl3xpu ?? null}
          localProfiles={snap.localProfiles ?? null}
          settings={snap.settings}
          notice={props.notice}
          onClose={() => props.onCancelLogin?.()}
          onSubmit={props.onConfigureLocal}
          onDownloadEngine={props.onDownloadEngine}
        />
      ) : null}
    </div>
  );
}

function romanNumeral(n: number): string {
  const map: Array<[number, string]> = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  if (n > 39) return String(n);
  let rest = n;
  let out = "";
  for (const [value, glyph] of map) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}
