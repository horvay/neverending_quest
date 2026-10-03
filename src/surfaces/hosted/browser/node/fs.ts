/** `node:fs` for the browser bundle; see ../vfs.ts. */
import * as vfs from "../vfs.ts";

export const { promises, constants, existsSync, readFileSync, readdirSync, statSync } = vfs;
export const lstatSync = vfs.statSync;
export function watch(): never {
  throw new Error("fs.watch is not available in the browser");
}
export default {
  promises: vfs.promises,
  constants: vfs.constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  watch,
};
