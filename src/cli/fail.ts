import { isCampaignError } from "../campaign/index.ts";

export function fail(err: unknown): number {
  if (isCampaignError(err)) {
    console.error(err.message);
    return 1;
  }
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}
