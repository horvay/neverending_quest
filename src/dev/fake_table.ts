/**
 * The fake table for working on the book without a model or a painter:
 * `NQ_FAKE_AGENT=1 nq serve` (or `nq play`). The Game Master answers with
 * `NQ_FAKE_PROSE`, and each Illustration variant is a solid colour swatch.
 * Tests never use it; they put a scripted model behind the real adapter.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { AgentSessionFactory, Illustrator } from "../play/types.ts";
import { FakeAgentFactory } from "./fake_agent.ts";

export type FakeTable = { factory: AgentSessionFactory; illustrator: Illustrator };

export function fakeTableFromEnv(): FakeTable | null {
  if (process.env.NQ_FAKE_AGENT !== "1" && process.env.NQ_USE_FAKE !== "1") {
    return null;
  }
  return {
    factory: new FakeAgentFactory({
      defaultProse: process.env.NQ_FAKE_PROSE ?? "The story continues.",
    }),
    illustrator: { paintOne: paintSwatch },
  };
}

async function paintSwatch({
  outPath,
  slot,
  signal,
}: {
  outPath: string;
  slot: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 380);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  }).catch(() => {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  if (signal?.aborted) return;
  await mkdir(path.dirname(outPath), { recursive: true });
  const color = FAKE_SIT_COLORS[slot] ?? FAKE_SIT_COLORS[0]!;
  await writeFile(outPath, solidPng(color));
}

const FAKE_SIT_COLORS: Array<[number, number, number]> = [
  [168, 72, 42],
  [62, 108, 78],
  [48, 86, 132],
  [196, 154, 62],
];

function pngChunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])) >>> 0);
  return Buffer.concat([len, tag, data, crc]);
}

function solidPng(rgb: [number, number, number], size = 96): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
