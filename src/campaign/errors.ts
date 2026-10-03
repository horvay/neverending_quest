export class CampaignError extends Error {
  readonly code: string;
  readonly diskText?: string;
  readonly diskHash?: string;

  constructor(
    code: string,
    message: string,
    extras?: { diskText?: string; diskHash?: string },
  ) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
    this.diskText = extras?.diskText;
    this.diskHash = extras?.diskHash;
  }
}

export function isCampaignError(err: unknown): err is CampaignError {
  return err instanceof CampaignError;
}
