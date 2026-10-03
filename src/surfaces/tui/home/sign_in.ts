/**
 * Choosing who the Game Master plays with: the Providers, then whatever the
 * sign-in asks for next (a pasted key, a Model, a thinking level), and the
 * wait while it signs in or warms a Game Master. Each sign-in screen belongs
 * to one phase of the surface's login; the runner shows it while the phase
 * lasts.
 */
import {
  LOCAL_PROVIDER_ID,
  visibleHomeChoices,
  type HomeLoginPhase,
  type HomeSnapshot,
} from "../../../home/index.ts";
import { LocalLoadScreen, type LocalMemory } from "./local_load.ts";
import { BACK, type HomeCtx, type HomeScreen, type Row, type View } from "./screen.ts";

export class ProvidersScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly more: boolean,
  ) {}

  view(snap: HomeSnapshot): View {
    const list = this.more ? snap.providers.more : snap.providers.featured;
    const rows: Row[] = list.map((provider) => ({
      name: provider.name,
      description: provider.connected ? "Connected" : "Sign in",
      value: `provider:${provider.id}`,
    }));
    if (!this.more && snap.providers.more.length > 0) {
      rows.push({ name: "More…", description: "", value: "more" });
    }
    rows.push(BACK);
    return { heading: snap.signedIn ? "Accounts" : "Sign in", rows };
  }

  async choose(value: string): Promise<void> {
    if (value === "more") {
      this.ctx.push(new ProvidersScreen(this.ctx, true));
      return;
    }
    if (value.startsWith("provider:")) {
      await this.ctx.surface.startLogin(value.slice("provider:".length));
    }
  }
}

/** Sign-in screens end the sign-in on Esc. */
abstract class SignInStep implements HomeScreen {
  constructor(protected readonly ctx: HomeCtx) {}
  abstract view(snap: HomeSnapshot): View;
  back(): void {
    this.ctx.surface.cancelLogin();
  }
}

class PromptScreen extends SignInStep {
  view(snap: HomeSnapshot): View {
    return {
      heading: "Sign in",
      rows: [],
      input: { value: "", placeholder: snap.login.placeholder || "Paste here" },
      hint: "Enter confirm · Esc back",
    };
  }

  async submit(text: string): Promise<void> {
    await this.ctx.surface.completePrompt(text);
  }
}

class ModelsScreen extends SignInStep {
  private query = "";

  view(snap: HomeSnapshot): View {
    const found = visibleHomeChoices(snap.models ?? [], this.query);
    const rows: Row[] = found.shown.map((model) => ({
      name: model.name,
      description: "",
      value: `model:${model.selector}`,
    }));
    rows.push(BACK);
    const lines = [snap.login.message ?? "Choose a Model."];
    if (found.needQuery) lines.push(`${found.total} models. Type to find one.`);
    else if (found.shown.length === 0) lines.push("Nothing matches.");
    return {
      heading: "Sign in",
      status: lines.join("\n"),
      rows,
      input: { value: this.query, placeholder: "Find a model", filter: true },
      hint: "Type to find · ↑↓ move · Enter select · Esc back",
    };
  }

  filter(text: string): void {
    this.query = text;
  }

  async choose(value: string): Promise<void> {
    if (value.startsWith("model:")) {
      await this.ctx.surface.pickModel(value.slice("model:".length));
    }
  }
}

class ReasoningScreen extends SignInStep {
  view(snap: HomeSnapshot): View {
    return {
      heading: "Sign in",
      rows: [
        ...(snap.reasoning ?? []).map((level) => ({
          name: level.name,
          description: "",
          value: `reasoning:${level.id}`,
        })),
        BACK,
      ],
    };
  }

  async choose(value: string): Promise<void> {
    if (value.startsWith("reasoning:")) {
      await this.ctx.surface.pickReasoning(value.slice("reasoning:".length));
    }
  }
}

/** Signing in, or warming the Game Master; Esc cancels. */
class WaitingScreen extends SignInStep {
  view(snap: HomeSnapshot): View {
    const local =
      snap.login.phase === "working" &&
      (snap.signedIn?.providerId === LOCAL_PROVIDER_ID ||
        snap.settings.model.startsWith(`${LOCAL_PROVIDER_ID}/`));
    if (local) {
      return {
        heading: "Loading local Game Master",
        status: [
          snap.login.message || "Starting the local model…",
          "Large models can take a little while. Home will stay locked until the Game Master is ready.",
        ].join("\n"),
        rows: [{ name: "Cancel loading", description: "", value: "back" }],
        hint: "Enter or Esc cancel",
      };
    }
    return {
      heading: "Sign in",
      rows: [{ name: "Cancel", description: "", value: "back" }],
      hint: "Enter or Esc cancel",
    };
  }
}

/** The screen a sign-in phase shows, if it has one. */
export function phaseScreen(
  ctx: HomeCtx,
  phase: HomeLoginPhase,
  memory: LocalMemory,
): HomeScreen | undefined {
  switch (phase) {
    case "awaiting_prompt":
      return new PromptScreen(ctx);
    case "awaiting_model":
      return new ModelsScreen(ctx);
    case "awaiting_reasoning":
      return new ReasoningScreen(ctx);
    case "awaiting_local":
      return new LocalLoadScreen(ctx, memory);
    case "working":
    case "awaiting_browser":
      return new WaitingScreen(ctx);
    case "idle":
    case "error":
      return undefined;
  }
}
