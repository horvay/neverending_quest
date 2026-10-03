import type { PlayHomeView, TuiChromeHandlers } from "./handlers.ts";
import {
  formatLocalLog,
  formatSettings,
  openPlaySettings,
  SETTINGS_HINT,
  type ReadView,
} from "./views.ts";

/** What settings and the AI log need from the chrome around them. */
export type SettingsHost = {
  handlers: TuiChromeHandlers;
  /** Show a view, or update it in place when that view is already open. */
  present(view: ReadView): void;
  say(notice?: string): void;
};

/**
 * Home's side of play: the mid-Campaign play settings (read, and `/set`
 * through Home in the server's own words) and the local AI log.
 */
export function createSettings(host: SettingsHost) {
  const { handlers } = host;
  let home: PlayHomeView | undefined;

  async function load(): Promise<PlayHomeView | undefined> {
    home = (await handlers.playHome?.().catch(() => undefined)) ?? home;
    return home;
  }

  async function show(status?: string): Promise<void> {
    const view = await load();
    if (!view) {
      host.say("Settings are not available here.");
      return;
    }
    host.present({
      kind: "text",
      name: "settings",
      text: formatSettings(view.settings, view.fixed, status),
      hint: SETTINGS_HINT,
    });
  }

  /** `/set <key> <value>`: typed text as the setting's own kind, else as given. */
  async function set(rawKey: string, raw: string): Promise<void> {
    const view = home ?? (await load());
    const spec = openPlaySettings(view?.fixed ?? []).find(
      (s) => s.key.toLowerCase() === rawKey.toLowerCase(),
    );
    if (!spec || !handlers.savePlaySettings) {
      host.say(`No setting ${rawKey} — /settings lists them.`);
      return;
    }
    const text = raw.trim();
    let value: unknown = raw;
    if (spec.kind === "number" && text !== "" && Number.isFinite(Number(text))) {
      value = Number(text);
    } else if (spec.kind === "flag") {
      const word = text.toLowerCase();
      if (["on", "true", "yes"].includes(word)) value = true;
      else if (["off", "false", "no"].includes(word)) value = false;
    } else if (spec.kind === "text") {
      value = text;
    }
    try {
      await handlers.savePlaySettings({ [spec.key]: value });
    } catch (err) {
      // Home's own words: "hygieneN must be between 1 and 10000.", …
      const message = err instanceof Error ? err.message : "Could not save settings.";
      await show(message);
      host.say(message);
      return;
    }
    await show("Saved. The next Turn uses these.");
  }

  async function showLog(source: "engine" | "host"): Promise<void> {
    const view = home ?? (await load());
    if (view?.diagnostics === false || !handlers.readLocalLog) {
      host.say("Diagnostics are off, so there is no AI log.");
      return;
    }
    let text: string;
    try {
      text = formatLocalLog(await handlers.readLocalLog(source));
    } catch {
      text = formatLocalLog({ error: "Could not read the local AI log." });
    }
    host.present({
      kind: "text",
      name: "log",
      text,
      hint: `Esc back · /log ${source === "engine" ? "host" : "engine"}`,
    });
  }

  return {
    load,
    show,
    set,
    showLog,
    get home() {
      return home;
    },
  };
}
