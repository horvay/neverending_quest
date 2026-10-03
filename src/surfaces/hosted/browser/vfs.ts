/**
 * The browser's file system for the hosted book: `node:fs` and
 * `node:fs/promises` as the Campaign code and isomorphic-git use them, over an
 * in-memory tree that mirrors the Origin Private File System (OPFS).
 *
 * Reads come from memory. Every change is written through to OPFS before the
 * call resolves, in call order, so a Campaign survives a reload once a write
 * returns. Paths under a memory-only mount (bundled Seed Packs, app files,
 * /tmp) never reach OPFS.
 */
import { Buffer } from "node:buffer";
import path from "node:path";

type Meta = { ino: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number };
type FileNode = Meta & { kind: "file"; data: Uint8Array };
type DirNode = Meta & { kind: "dir" };
type VNode = FileNode | DirNode;

const nodes = new Map<string, VNode>();
let nextIno = 1;
const memoryOnly: string[] = [];
let opfsRoot: FileSystemDirectoryHandle | null = null;
let queue: Promise<unknown> = Promise.resolve();

function meta(): Meta {
  const now = Date.now();
  return { ino: nextIno++, mtimeMs: now, ctimeMs: now, birthtimeMs: now };
}
nodes.set("/", { kind: "dir", ...meta() });

export function norm(p: string | URL): string {
  const raw = typeof p === "string" ? p : p.pathname;
  return path.posix.resolve("/", raw);
}

function fsError(code: string, syscall: string, p: string): Error {
  const messages: Record<string, string> = {
    ENOENT: "no such file or directory",
    EEXIST: "file already exists",
    ENOTDIR: "not a directory",
    EISDIR: "illegal operation on a directory",
    ENOTEMPTY: "directory not empty",
    EINVAL: "invalid argument",
    ENOSYS: "function not implemented",
  };
  const err = new Error(`${code}: ${messages[code] ?? code}, ${syscall} '${p}'`) as Error & {
    code: string;
    syscall: string;
    path: string;
    errno: number;
  };
  err.code = code;
  err.syscall = syscall;
  err.path = p;
  err.errno = -1;
  return err;
}

function isMemoryOnly(p: string): boolean {
  return memoryOnly.some((m) => p === m || p.startsWith(`${m}/`));
}

function parentOf(p: string): string {
  return path.posix.dirname(p);
}

function requireDir(p: string, syscall: string): DirNode {
  const n = nodes.get(p);
  if (!n) throw fsError("ENOENT", syscall, p);
  if (n.kind !== "dir") throw fsError("ENOTDIR", syscall, p);
  return n;
}

function childrenOf(dir: string): string[] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const out: string[] = [];
  for (const key of nodes.keys()) {
    if (key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
      out.push(key.slice(prefix.length));
    }
  }
  return out.sort();
}

function toBytes(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, (encoding as BufferEncoding) ?? "utf8"));
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return new Uint8Array(Buffer.from(String(data)));
}

function encodingOf(opts: unknown): string | undefined {
  if (typeof opts === "string") return opts;
  if (opts && typeof opts === "object" && "encoding" in opts) {
    const e = (opts as { encoding?: unknown }).encoding;
    return typeof e === "string" ? e : undefined;
  }
  return undefined;
}

// ── OPFS write-through ───────────────────────────────────────────────────

async function opfsDir(p: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsRoot) return null;
  let dir = opfsRoot;
  for (const part of p.split("/").filter(Boolean)) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

function persist(op: () => Promise<void>): Promise<void> {
  const run = queue.then(op, op);
  queue = run.catch(() => {});
  return run;
}

function persistWrite(p: string, data: Uint8Array): Promise<void> {
  if (!opfsRoot || isMemoryOnly(p)) return Promise.resolve();
  return persist(async () => {
    const dir = await opfsDir(parentOf(p), true);
    if (!dir) return;
    const handle = await dir.getFileHandle(path.posix.basename(p), { create: true });
    const w = await handle.createWritable();
    await w.write(data as unknown as ArrayBuffer);
    await w.close();
  });
}

function persistMkdir(p: string): Promise<void> {
  if (!opfsRoot || isMemoryOnly(p)) return Promise.resolve();
  return persist(async () => {
    await opfsDir(p, true);
  });
}

function persistRemove(p: string): Promise<void> {
  if (!opfsRoot || isMemoryOnly(p) || p === "/") return Promise.resolve();
  return persist(async () => {
    const dir = await opfsDir(parentOf(p), false);
    await dir?.removeEntry(path.posix.basename(p), { recursive: true }).catch(() => {});
  });
}

/** Load everything already in OPFS into memory. Call once before anything reads. */
export async function mountOpfs(root?: FileSystemDirectoryHandle): Promise<void> {
  opfsRoot = root ?? (await navigator.storage.getDirectory());
  const walk = async (dir: FileSystemDirectoryHandle, at: string): Promise<void> => {
    for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      const p = at === "/" ? `/${name}` : `${at}/${name}`;
      if (handle.kind === "directory") {
        if (!nodes.has(p)) nodes.set(p, { kind: "dir", ...meta() });
        await walk(handle as FileSystemDirectoryHandle, p);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        const m = meta();
        m.mtimeMs = m.ctimeMs = file.lastModified;
        nodes.set(p, { kind: "file", data, ...m });
      }
    }
  };
  await walk(opfsRoot, "/");
}

/** Files that live only in memory for this page load, e.g. bundled Seed Packs. */
export function mountMemory(at: string, files: Record<string, string>): void {
  const root = norm(at);
  memoryOnly.push(root);
  mkdirpSync(root);
  for (const [rel, text] of Object.entries(files)) {
    const p = norm(path.posix.join(root, rel));
    mkdirpSync(parentOf(p));
    nodes.set(p, { kind: "file", data: toBytes(text), ...meta() });
  }
}

/** Resolves once every write so far has reached OPFS. */
export function flushed(): Promise<void> {
  return queue.then(() => {});
}

function mkdirpSync(p: string): void {
  if (nodes.has(p)) return;
  mkdirpSync(parentOf(p));
  nodes.set(p, { kind: "dir", ...meta() });
}

// ── Node API ─────────────────────────────────────────────────────────────

class Stats {
  constructor(private readonly n: VNode) {}
  get size() {
    return this.n.kind === "file" ? this.n.data.length : 4096;
  }
  get mode() {
    return this.n.kind === "file" ? 0o100644 : 0o40755;
  }
  get ino() {
    return this.n.ino;
  }
  readonly dev = 1;
  readonly uid = 0;
  readonly gid = 0;
  readonly nlink = 1;
  get mtimeMs() {
    return this.n.mtimeMs;
  }
  get ctimeMs() {
    return this.n.ctimeMs;
  }
  get birthtimeMs() {
    return this.n.birthtimeMs;
  }
  get atimeMs() {
    return this.n.mtimeMs;
  }
  get mtime() {
    return new Date(this.n.mtimeMs);
  }
  get ctime() {
    return new Date(this.n.ctimeMs);
  }
  get atime() {
    return new Date(this.n.mtimeMs);
  }
  get birthtime() {
    return new Date(this.n.birthtimeMs);
  }
  isFile() {
    return this.n.kind === "file";
  }
  isDirectory() {
    return this.n.kind === "dir";
  }
  isSymbolicLink() {
    return false;
  }
}

class Dirent {
  constructor(
    readonly name: string,
    private readonly kind: "file" | "dir",
    readonly parentPath: string,
  ) {}
  get path() {
    return this.parentPath;
  }
  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "dir";
  }
  isSymbolicLink() {
    return false;
  }
}

export function statSync(p: string | URL): Stats {
  const key = norm(p);
  const n = nodes.get(key);
  if (!n) throw fsError("ENOENT", "stat", key);
  return new Stats(n);
}

export function existsSync(p: string | URL): boolean {
  return nodes.has(norm(p));
}

export function readFileSync(p: string | URL, opts?: unknown): string | Buffer {
  const key = norm(p);
  const n = nodes.get(key);
  if (!n) throw fsError("ENOENT", "open", key);
  if (n.kind !== "file") throw fsError("EISDIR", "read", key);
  const enc = encodingOf(opts);
  const buf = Buffer.from(n.data);
  return enc ? buf.toString(enc as BufferEncoding) : buf;
}

export function readdirSync(p: string | URL, opts?: { withFileTypes?: boolean }): Array<string | Dirent> {
  const key = norm(p);
  requireDir(key, "scandir");
  const names = childrenOf(key);
  if (!opts?.withFileTypes) return names;
  return names.map((name) => new Dirent(name, nodes.get(path.posix.join(key, name))!.kind, key));
}

function writeNode(key: string, data: Uint8Array): void {
  const parent = nodes.get(parentOf(key));
  if (!parent) throw fsError("ENOENT", "open", key);
  if (parent.kind !== "dir") throw fsError("ENOTDIR", "open", key);
  const prior = nodes.get(key);
  if (prior?.kind === "dir") throw fsError("EISDIR", "open", key);
  const now = Date.now();
  nodes.set(key, {
    kind: "file",
    data,
    ino: prior?.ino ?? nextIno++,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: prior?.birthtimeMs ?? now,
  });
}

export const promises = {
  async readFile(p: string | URL, opts?: unknown) {
    return readFileSync(p, opts);
  },
  async writeFile(p: string | URL, data: unknown, opts?: unknown) {
    const key = norm(p);
    const bytes = toBytes(data, encodingOf(opts));
    writeNode(key, bytes);
    await persistWrite(key, bytes);
  },
  async appendFile(p: string | URL, data: unknown, opts?: unknown) {
    const key = norm(p);
    const prior = nodes.get(key);
    const add = toBytes(data, encodingOf(opts));
    const bytes =
      prior?.kind === "file"
        ? (() => {
            const out = new Uint8Array(prior.data.length + add.length);
            out.set(prior.data);
            out.set(add, prior.data.length);
            return out;
          })()
        : add;
    writeNode(key, bytes);
    await persistWrite(key, bytes);
  },
  async mkdir(p: string | URL, opts?: { recursive?: boolean } | number) {
    const key = norm(p);
    const recursive = typeof opts === "object" && opts?.recursive === true;
    const existing = nodes.get(key);
    if (existing) {
      if (recursive && existing.kind === "dir") return undefined;
      throw fsError("EEXIST", "mkdir", key);
    }
    if (!recursive) {
      requireDir(parentOf(key), "mkdir");
      nodes.set(key, { kind: "dir", ...meta() });
      await persistMkdir(key);
      return undefined;
    }
    const made: string[] = [];
    let at = key;
    while (!nodes.has(at)) {
      made.unshift(at);
      at = parentOf(at);
    }
    if (nodes.get(at)!.kind !== "dir") throw fsError("ENOTDIR", "mkdir", at);
    for (const d of made) nodes.set(d, { kind: "dir", ...meta() });
    await persistMkdir(key);
    return made[0];
  },
  async readdir(p: string | URL, opts?: { withFileTypes?: boolean }) {
    return readdirSync(p, opts);
  },
  async stat(p: string | URL) {
    return statSync(p);
  },
  async lstat(p: string | URL) {
    return statSync(p);
  },
  async access(p: string | URL) {
    const key = norm(p);
    if (!nodes.has(key)) throw fsError("ENOENT", "access", key);
  },
  async realpath(p: string | URL) {
    const key = norm(p);
    if (!nodes.has(key)) throw fsError("ENOENT", "realpath", key);
    return key;
  },
  async unlink(p: string | URL) {
    const key = norm(p);
    const n = nodes.get(key);
    if (!n) throw fsError("ENOENT", "unlink", key);
    if (n.kind === "dir") throw fsError("EISDIR", "unlink", key);
    nodes.delete(key);
    await persistRemove(key);
  },
  async rmdir(p: string | URL) {
    const key = norm(p);
    requireDir(key, "rmdir");
    if (childrenOf(key).length > 0) throw fsError("ENOTEMPTY", "rmdir", key);
    nodes.delete(key);
    await persistRemove(key);
  },
  async rm(p: string | URL, opts?: { recursive?: boolean; force?: boolean }) {
    const key = norm(p);
    const n = nodes.get(key);
    if (!n) {
      if (opts?.force) return;
      throw fsError("ENOENT", "rm", key);
    }
    if (n.kind === "dir") {
      if (!opts?.recursive) throw fsError("EISDIR", "rm", key);
      const prefix = `${key}/`;
      for (const k of [...nodes.keys()]) if (k.startsWith(prefix)) nodes.delete(k);
    }
    nodes.delete(key);
    await persistRemove(key);
  },
  async rename(from: string | URL, to: string | URL) {
    const src = norm(from);
    const dst = norm(to);
    const n = nodes.get(src);
    if (!n) throw fsError("ENOENT", "rename", src);
    requireDir(parentOf(dst), "rename");
    if (src === dst) return;
    const moved: Array<[string, VNode]> = [];
    const prefix = `${src}/`;
    for (const [k, v] of nodes) {
      if (k === src || k.startsWith(prefix)) moved.push([k, v]);
    }
    const target = nodes.get(dst);
    if (target?.kind === "dir" && n.kind === "file") throw fsError("EISDIR", "rename", dst);
    if (target) await promises.rm(dst, { recursive: true, force: true });
    for (const [k] of moved) nodes.delete(k);
    for (const [k, v] of moved) nodes.set(dst + k.slice(src.length), v);
    // OPFS has no portable rename: write the new tree, then drop the old one
    for (const [k, v] of moved) {
      const nk = dst + k.slice(src.length);
      if (v.kind === "dir") await persistMkdir(nk);
      else await persistWrite(nk, v.data);
    }
    await persistRemove(src);
  },
  async copyFile(from: string | URL, to: string | URL) {
    const data = readFileSync(from) as Buffer;
    await promises.writeFile(to, data);
  },
  async readlink(p: string | URL) {
    throw fsError("EINVAL", "readlink", norm(p));
  },
  async symlink(_target: string, p: string | URL) {
    throw fsError("ENOSYS", "symlink", norm(p));
  },
  async chmod() {},
  async utimes() {},
  async open(p: string | URL) {
    throw fsError("ENOSYS", "open", norm(p));
  },
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
