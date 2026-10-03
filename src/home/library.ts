import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newCampaign } from "../campaign/new.ts";
import { readCampaignMeta } from "../campaign/open.ts";
import { isEnoent } from "../campaign/fs_util.ts";
import type { CampaignMeta } from "../campaign/types.ts";
import type { CampaignCard } from "./types.ts";

export function defaultCampaignsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local/share");
  return path.join(base, "nq", "campaigns");
}

export async function listLibraryCampaigns(
  campaignsDir: string = defaultCampaignsDir(),
): Promise<CampaignCard[]> {
  let names: string[];
  try {
    names = await readdir(campaignsDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const cards: CampaignCard[] = [];
  for (const name of names) {
    const dir = path.join(campaignsDir, name);
    try {
      const meta = await readCampaignMeta(dir);
      cards.push({ id: meta.id, name: meta.name, path: dir });
    } catch {
      // Skip non-Campaign siblings in the library directory.
    }
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

export async function deleteLibraryCampaign(
  id: string,
  campaignsDir: string = defaultCampaignsDir(),
): Promise<CampaignCard | null> {
  const campaign = (await listLibraryCampaigns(campaignsDir)).find(
    (card) => card.id === id,
  );
  if (!campaign) return null;
  await rm(campaign.path, { recursive: true });
  return campaign;
}

export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "campaign";
}

export async function birthLibraryCampaign(opts: {
  packDir: string;
  title: string;
  campaignsDir?: string;
  now?: () => Date;
  id?: () => string;
}): Promise<{ meta: CampaignMeta; path: string }> {
  const campaignsDir = opts.campaignsDir ?? defaultCampaignsDir();
  await mkdir(campaignsDir, { recursive: true });
  const slug = slugifyTitle(opts.title);
  const makeId = opts.id ?? (() => crypto.randomUUID());
  let lastId = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = makeId();
    lastId = id;
    const short = id.replace(/-/g, "").slice(0, 8) || id.slice(0, 8);
    const dest = path.join(campaignsDir, `${slug}-${short}`);
    try {
      const meta = await newCampaign({
        path: dest,
        packDir: opts.packDir,
        name: opts.title.trim() || slug,
        now: opts.now,
        id: () => id,
      });
      return { meta, path: dest };
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "target_nonempty"
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not allocate a Campaign folder for ${slug} (${lastId})`);
}
