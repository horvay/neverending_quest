/**
 * Wire constants of the sealed transport, shared by the Node half
 * (`protocol.ts`, the loopback proxy and the worker) and the browser half
 * (`browser.ts`). No runtime imports, so both bundles can take it.
 */
export const SEAL_VERSION = "nq-seal-v1";
export const SEAL_HELLO_PATH = "/.seal/hello";
export const SEAL_CALL_PATH = "/.seal/call";
export const SEAL_SESSION_HEADER = "x-seal-session";
export const SEAL_SEQ_HEADER = "x-seal-seq";

export const FRAME_HEAD = 0;
export const FRAME_DATA = 1;
export const FRAME_END = 2;
export type FrameType = typeof FRAME_HEAD | typeof FRAME_DATA | typeof FRAME_END;

export type ResponseHead = { status: number; headers: Record<string, string> };
