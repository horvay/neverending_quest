/**
 * Home's hub and its library: Continue (open or delete a Campaign) and New
 * adventure (a Seed Pack, then its title).
 */
import { LOCAL_PROVIDER_ID, type HomeSnapshot } from "../../../home/index.ts";
import { AlmanacIndexScreen } from "./almanac.ts";
import { BACK, type HomeCtx, type HomeScreen, type Row, type View } from "./screen.ts";
import { openSettings } from "./settings.ts";
import { ProvidersScreen } from "./sign_in.ts";

/** The Almanac is about local models; it has nothing for a cloud account. */
function localInstalled(snap: HomeSnapshot): boolean {
  return snap.providers.featured.some((provider) => provider.id === LOCAL_PROVIDER_ID);
}

export class HubScreen implements HomeScreen {
  constructor(private readonly ctx: HomeCtx) {}

  view(snap: HomeSnapshot): View {
    const rows: Row[] = [];
    if (!snap.locked && snap.choosesGameMaster) {
      rows.push({
        name: snap.signedIn ? "Accounts" : "Sign in",
        description: snap.signedIn
          ? `${snap.signedIn.provider}${snap.signedIn.model ? ` · ${snap.signedIn.model}` : ""}`
          : "Grok, Claude, ChatGPT, or this computer",
        value: "sign-in",
      });
    }
    rows.push(
      {
        name: "Continue",
        description:
          snap.campaigns.length === 0
            ? "No Campaigns yet"
            : `${snap.campaigns.length} Campaign${snap.campaigns.length === 1 ? "" : "s"}`,
        value: "continue",
      },
      { name: "New adventure", description: "Start from a Seed Pack", value: "new" },
      {
        name: "Settings",
        description: "Game Master, memory, and advanced settings",
        value: "settings",
      },
    );
    if (localInstalled(snap)) {
      rows.push({
        name: "Almanac",
        description: "Recommended settings for each family of local model",
        value: "almanac",
      });
    }
    rows.push({ name: "Leave", description: "Exit", value: "quit" });
    return { rows, hint: "↑↓ move · Enter select · Esc leave · Ctrl+C leave" };
  }

  choose(value: string): void {
    const { ctx } = this;
    if (value === "quit") ctx.finish("quit");
    else if (value === "sign-in") ctx.push(new ProvidersScreen(ctx, false));
    else if (value === "continue") ctx.push(new ContinueScreen(ctx));
    else if (value === "new") ctx.push(new PacksScreen(ctx));
    else if (value === "settings") openSettings(ctx);
    else if (value === "almanac") ctx.push(new AlmanacIndexScreen(ctx));
  }

  back(): void {
    this.ctx.finish("quit");
  }
}

class ContinueScreen implements HomeScreen {
  constructor(private readonly ctx: HomeCtx) {}

  view(snap: HomeSnapshot): View {
    const rows: Row[] = snap.campaigns.map((campaign) => ({
      name: campaign.name,
      description: "",
      value: `campaign:${campaign.id}`,
    }));
    if (rows.length === 0) {
      rows.push({ name: "(none yet)", description: "Start a new adventure", value: "new" });
    }
    rows.push(BACK);
    return { heading: "Continue", rows, hint: "↑↓ move · Enter open · D delete · Esc back" };
  }

  async choose(value: string): Promise<void> {
    if (value === "new") {
      this.ctx.pop();
      this.ctx.push(new PacksScreen(this.ctx));
      return;
    }
    if (value.startsWith("campaign:")) {
      await this.ctx.surface.openById(value.slice("campaign:".length));
    }
  }

  key(name: string, selected: string | undefined): boolean {
    if (name.toLowerCase() !== "d") return false;
    const id = selected?.startsWith("campaign:") ? selected.slice("campaign:".length) : "";
    const campaign = this.ctx.snap().campaigns.find((item) => item.id === id);
    if (!campaign) return true;
    this.ctx.push(new DeleteScreen(this.ctx, campaign));
    return true;
  }
}

class DeleteScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly campaign: { id: string; name: string },
  ) {}

  view(): View {
    return {
      heading: "Continue",
      status: `Delete "${this.campaign.name}"? This permanently deletes its Campaign folder from disk and cannot be undone.`,
      rows: [
        {
          name: "Delete from disk",
          description: "Permanently remove story, notes, and history",
          value: "delete",
        },
        { name: "Cancel", description: "Keep this Campaign", value: "back" },
      ],
      hint: "Enter confirm · Esc cancel",
    };
  }

  async choose(value: string): Promise<void> {
    if (value !== "delete") return;
    await this.ctx.surface.deleteById(this.campaign.id);
    this.ctx.pop();
  }
}

class PacksScreen implements HomeScreen {
  constructor(private readonly ctx: HomeCtx) {}

  view(snap: HomeSnapshot): View {
    return {
      heading: "New adventure",
      rows: [
        ...snap.packs.map((pack) => ({
          name: pack.name,
          description: pack.description ?? "",
          value: `pack:${pack.id}`,
        })),
        BACK,
      ],
    };
  }

  choose(value: string): void {
    if (!value.startsWith("pack:")) return;
    const id = value.slice("pack:".length);
    const pack = this.ctx.snap().packs.find((item) => item.id === id);
    this.ctx.push(new TitleScreen(this.ctx, { id, name: pack?.name ?? id }));
  }
}

class TitleScreen implements HomeScreen {
  constructor(
    private readonly ctx: HomeCtx,
    private readonly pack: { id: string; name: string },
  ) {}

  view(): View {
    return {
      heading: "New adventure",
      status: `Title for ${this.pack.name}:`,
      rows: [],
      input: { value: this.pack.name, placeholder: this.pack.name },
      hint: "Enter confirm · Esc back",
    };
  }

  async submit(text: string): Promise<void> {
    await this.ctx.surface.birthAndOpen(this.pack.id, text.trim() || this.pack.name);
  }
}
