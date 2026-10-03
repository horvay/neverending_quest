import { isCampaignError } from "../../../campaign/errors.ts";

/**
 * What the player reads when a play command is refused: the web book's
 * wording, chosen by the same Campaign error the book's HTTP status carries.
 */

export const BUSY = "Busy — try again when Idle.";
export const STALE = "Changed on disk — showing disk text.";

type Action =
  | "retry"
  | "continue"
  | "save"
  | "create"
  | "luck"
  | "illustrate"
  | "keep"
  | "answer";

const code = (err: unknown): string | undefined =>
  isCampaignError(err) ? err.code : undefined;

/** Errors the book shows in the server's own words. */
const SERVER_WORDS = new Set(["unavailable", "bad_prompt", "generate_failed"]);

export function refusal(action: Action, err: unknown): string {
  const c = code(err);
  const busy = c === "busy" || c === "not_last";
  switch (action) {
    case "retry":
      if (busy) return BUSY;
      if (c === "not_found") return "Only the latest Game Master reply can be retried.";
      if (c === "bad_prompt") return "This Game Master cannot continue from edited scratch.";
      return "Could not retry this reply.";
    case "continue":
      if (busy) return BUSY;
      if (c === "not_found") return "That line is not on the current play.";
      return "Could not continue.";
    case "save":
      if (busy || c === "dossier_exists") return BUSY;
      if (c === "dossier_slug_invalid") return "Could not save.";
      if (c === "not_found" || c === "inspect_forbidden" || c === "dossier_missing") {
        return "That file cannot be written.";
      }
      return "Could not save.";
    case "create":
      if (busy || c === "dossier_exists") return "A dossier with that slug already exists.";
      if (c === "dossier_slug_invalid") return "Invalid slug.";
      if (c === "not_found" || c === "inspect_forbidden" || c === "dossier_missing") {
        return "That file cannot be written.";
      }
      return "Could not save.";
    case "luck":
      return busy ? BUSY : "Could not change Luck Points.";
    case "illustrate":
    case "keep":
      if (c && SERVER_WORDS.has(c) && err instanceof Error) return err.message;
      if (busy) return BUSY;
      if (c === "not_found") return "No Game Master row to illustrate.";
      return "Could not illustrate this line.";
    case "answer":
      return "Could not end local reasoning.";
  }
}
