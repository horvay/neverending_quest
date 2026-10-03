import { rm, stat } from "node:fs/promises";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";
import { resolveCampaignPath, readCampaignMeta } from "./open.ts";
import type { CampaignMeta } from "./types.ts";

export type DeleteCampaignInfo = {
  path: string;
  meta: CampaignMeta;
};

export type DeleteCampaignResult = DeleteCampaignInfo & {
  /** False when the caller declined the confirmation prompt. */
  deleted: boolean;
};

export type DeleteCampaignOptions = {
  path?: string;
  /**
   * Called after the path is validated as a Campaign and before any delete.
   * Return true to proceed. Required — callers must own the "are you sure" UX.
   */
  confirm: (info: DeleteCampaignInfo) => boolean | Promise<boolean>;
  /** Injected for tests. */
  remove?: (absPath: string) => Promise<void>;
};

/**
 * Permanently remove a Campaign folder after an explicit confirm callback.
 * Refuses paths that are not Campaigns (missing/invalid campaign.yaml).
 */
export async function deleteCampaign(
  opts: DeleteCampaignOptions,
): Promise<DeleteCampaignResult> {
  const campaignPath = await resolveCampaignPath(opts.path);
  await assertDirectory(campaignPath);
  const meta = await readCampaignMeta(campaignPath);
  const info: DeleteCampaignInfo = { path: campaignPath, meta };

  const ok = await opts.confirm(info);
  if (!ok) {
    return { ...info, deleted: false };
  }

  const remove =
    opts.remove ??
    (async (abs: string) => {
      await rm(abs, { recursive: true, force: false });
    });
  await remove(campaignPath);
  return { ...info, deleted: true };
}

async function assertDirectory(campaignPath: string): Promise<void> {
  try {
    const st = await stat(campaignPath);
    if (!st.isDirectory()) {
      throw new CampaignError(
        "not_a_campaign",
        `Not a Campaign directory: ${campaignPath}`,
      );
    }
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    if (isEnoent(err)) {
      throw new CampaignError(
        "not_a_campaign",
        `No Campaign at ${campaignPath}`,
      );
    }
    throw err;
  }
}
