export class HomeError extends Error {
  readonly code:
    | "busy"
    | "locked"
    | "need_sign_in"
    | "unknown_provider"
    | "unknown_pack"
    | "unknown_campaign"
    | "login"
    | "settings"
    | "delete_failed"
    | "open_failed";

  constructor(code: HomeError["code"], message: string) {
    super(message);
    this.name = "HomeError";
    this.code = code;
  }
}

export function isHomeError(err: unknown): err is HomeError {
  return err instanceof HomeError;
}
