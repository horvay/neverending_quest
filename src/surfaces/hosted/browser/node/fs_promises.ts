/** `node:fs/promises` for the browser bundle; see ../vfs.ts. */
import { promises } from "../vfs.ts";

export const {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  stat,
  lstat,
  access,
  realpath,
  unlink,
  rmdir,
  rm,
  rename,
  copyFile,
  readlink,
  symlink,
  chmod,
  utimes,
  open,
} = promises;
export async function mkdtemp(prefix: string): Promise<string> {
  const dir = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
  await promises.mkdir(dir, { recursive: true });
  return dir;
}
export default { ...promises, mkdtemp };
