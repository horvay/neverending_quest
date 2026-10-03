import { useEffect, useRef, useState } from "preact/hooks";
import type { HomeView } from "../api.ts";
import { isLlamaCppModel } from "../../../model_selector.ts";
import { api, type Reply } from "./api_client.ts";
import type { HomeAppProps } from "./home.tsx";

/**
 * Home as the book sees it: `undefined` while the first snapshot loads, `null`
 * when the server has no Home (an older single-Campaign server), else the view.
 */
export type HomeState = HomeView | null | undefined;

function emptyHome(message?: string): HomeView {
  return {
    signedIn: null,
    locked: false,
    login: message ? { phase: "error", message } : { phase: "idle" },
    providers: { featured: [], more: [] },
    models: null,
    mmproj: null,
    gpus: null,
    exl3xpu: null,
    localProfiles: null,
    reasoning: null,
    campaigns: [],
    packs: [],
    open: null,
    fixedSettings: [],
    diagnostics: true,
    choosesGameMaster: true,
    settings: {
      model: "",
      turnTimeoutSec: 180,
      reasoning: "low",
      hygieneN: 10,
      compactCeilingTokens: 30_000,
      compactSeedPercent: 50,
      playTranscriptTailRows: 20,
      maxTokens: 8192,
      searchFullModel: "",
      searchFullReasoning: "",
      gmVoicePath: "",
      gmPersonality: "",
      localThinkingOpener: "",
      localContextTokens: 65_536,
      localReasoningTokens: -1,
      localCacheK: "q8_0",
      localCacheV: "turbo3",
      localTuning: {},
      localKvOffload: true,
      localFlashAttention: true,
      debug: false,
      logPath: "",
      servePort: 7737,
    },
  };
}

/**
 * The address names the open adventure — `/play/<title>-<first 8 of its id>`,
 * the same shape as its folder — so a reload or a bookmark goes straight back
 * into it. Only the id part is used to find it.
 */
function adventureKey(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

function adventurePath(open: { id: string; name: string }): string {
  const slug = open.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/play/${slug ? `${slug}-` : ""}${adventureKey(open.id)}`;
}

function adventureFromPath(pathname: string): string | null {
  const m = /^\/play\/(?:[^/]*-)?([0-9a-f]{8})\/?$/i.exec(pathname);
  return m ? m[1]!.toLowerCase() : null;
}

type HomeLoad =
  | { kind: "ok"; view: HomeView }
  | { kind: "missing" }
  | { kind: "error"; view: HomeView };

async function loadHome(): Promise<HomeLoad> {
  const reply = await api.home();
  if (reply.ok) return { kind: "ok", view: reply.body };
  if (reply.status === 404) return { kind: "missing" };
  return { kind: "error", view: emptyHome("Could not load Home.") };
}

function viewOf(load: HomeLoad): HomeState {
  return load.kind === "missing" ? null : load.view;
}

export function useHome() {
  const [home, setHome] = useState<HomeState>(undefined);
  const [titleDraft, setTitleDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedPack, setSelectedPack] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  /** An adventure the address asks for, until Home has tried to open it. */
  const [routing, setRouting] = useState<string | null>(() =>
    adventureFromPath(window.location.pathname),
  );
  const homeRef = useRef(home);
  homeRef.current = home;
  /** Only the latest Home request may move Home on; older answers are dropped. */
  const requestVersion = useRef(0);
  const playing = home === null || Boolean(home?.open);

  async function refresh(): Promise<void> {
    setHome(viewOf(await loadHome()));
  }

  /** Run one Home step, show its failure words, then show Home as it is now. */
  async function step(run: () => Promise<Reply<unknown>>): Promise<boolean> {
    const version = ++requestVersion.current;
    const reply = await run();
    if (version !== requestVersion.current) return false;
    if (!reply.ok) {
      setNotice(
        reply.status === 0
          ? "Could not reach Home."
          : (reply.error ?? "Something went wrong."),
      );
      await refresh();
      return false;
    }
    setNotice("");
    await refresh();
    return true;
  }

  /** Show the warm-up dialog at once; the server's own copy follows. */
  function beginLocalLoad(model?: string) {
    setNotice("");
    setHome((current) =>
      current
        ? {
            ...current,
            ...(model ? { settings: { ...current.settings, model } } : {}),
            login: { phase: "working", message: "Warming the Game Master…" },
          }
        : current,
    );
  }

  function openCampaign(id: string, view: HomeState = homeRef.current) {
    if (isLocalModel(view)) beginLocalLoad();
    return step(() => api.openCampaign(id));
  }

  /** Open the adventure an address names, if it is not the open one already. */
  async function openFromRoute(key: string | null, snap: HomeView): Promise<void> {
    if (key && !snap.open) {
      const card = snap.campaigns.find((c) => adventureKey(c.id) === key);
      if (card) await openCampaign(card.id, snap);
      else setNotice("That adventure is not in this browser.");
    }
    setRouting(null);
  }

  async function leave(): Promise<void> {
    await api.leave();
    await refresh();
  }

  async function cancelWork() {
    const version = ++requestVersion.current;
    setHome((current) => (current ? { ...current, login: { phase: "idle" } } : current));
    const reply = await api.loginCancel();
    if (version !== requestVersion.current) return;
    if (reply.status === 0) setNotice("Could not cancel local model loading.");
    else await refresh();
  }

  useEffect(() => {
    void loadHome().then((load) => {
      setHome(viewOf(load));
      if (load.kind === "ok") {
        void openFromRoute(adventureFromPath(window.location.pathname), load.view);
      }
    });
  }, []);

  // keep the address on the open adventure, or on Home
  useEffect(() => {
    if (!home || routing) return;
    const want = home.open ? adventurePath(home.open) : "/";
    const at = window.location.pathname;
    if (at === want) return;
    // entering or leaving an adventure is a step Back can undo
    if ((want === "/") !== (at === "/")) window.history.pushState(null, "", want);
    else window.history.replaceState(null, "", want);
  }, [home, routing]);

  // Back and Forward move between Home and the adventure
  useEffect(() => {
    const onPop = () => {
      const current = homeRef.current;
      if (!current) return;
      const key = adventureFromPath(window.location.pathname);
      if (!key && current.open) void leave();
      else if (key && !current.open) {
        setRouting(key);
        void openFromRoute(key, current);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // sign-in and model warm-up move on the server; follow them
  useEffect(() => {
    if (playing || !home) return;
    if (home.login.phase === "idle" || home.login.phase === "error") return;
    const t = setInterval(() => void refresh(), 400);
    return () => clearInterval(t);
  }, [playing, home?.login.phase]);

  /** HomeApp's props, minus the view itself. */
  const actions: Omit<HomeAppProps, "snap"> = {
    titleDraft,
    promptDraft,
    moreOpen,
    selectedPack,
    notice,
    onSignIn: (provider) => void step(() => api.login(provider)),
    onPromptDraft: setPromptDraft,
    onPrompt: (text) =>
      void step(() => api.loginPrompt(text)).then((ok) => {
        if (ok) setPromptDraft("");
      }),
    onPickModel: (model) => void step(() => api.loginModel(model)),
    onPickReasoning: (reasoning) => void step(() => api.loginReasoning(reasoning)),
    onConfigureLocal: (local) => {
      beginLocalLoad(local.model);
      void step(() => api.loginLocal(local));
    },
    onDownloadEngine: (backend) => step(() => api.loginEngine(backend)),
    onOpenCampaign: (id) => void openCampaign(id),
    onDeleteCampaign: (id) => {
      setNotice("");
      return step(() => api.deleteCampaign(id));
    },
    onSelectPack: (id, packName) => {
      setSelectedPack(id);
      setTitleDraft(packName);
    },
    onTitle: setTitleDraft,
    onBirth: () => {
      if (isLocalModel(homeRef.current)) beginLocalLoad();
      void step(() => api.birth(selectedPack ?? "", titleDraft));
    },
    onToggleMore: () => setMoreOpen((v) => !v),
    onSaveSettings: (settings) => {
      if (isLlamaCppModel(settings.model)) beginLocalLoad(settings.model);
      return step(() => api.settings(settings));
    },
    onCancelLogin: () => void cancelWork(),
  };

  return {
    home,
    setHome,
    playing,
    /** On the way into the adventure the address names. */
    routing,
    actions,
    refresh,
    leave,
  };
}

/** A Game Master this machine loads first, so Home shows the warm-up. */
function isLocalModel(home: HomeState): boolean {
  return Boolean(home?.settings.model.startsWith("llama.cpp/"));
}
