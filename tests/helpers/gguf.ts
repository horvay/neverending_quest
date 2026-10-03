import { writeFile } from "node:fs/promises";

export type GgufFixtureValue = number | bigint | boolean | string;

export type GgufFixture = {
  architecture: string;
  values?: Record<string, GgufFixtureValue>;
  /** Adds a string array under this key to exercise array skipping. */
  stringArray?: { key: string; count: number };
  version?: number;
  /** Tensor infos written after the header, named but with no data. */
  tensors?: string[];
};

class ByteWriter {
  private chunks: Uint8Array[] = [];

  u32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    this.chunks.push(b);
  }

  u64(value: bigint | number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
    this.chunks.push(b);
  }

  f32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    this.chunks.push(b);
  }

  u8(value: number): void {
    this.chunks.push(Uint8Array.of(value));
  }

  string(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.u64(bytes.length);
    this.chunks.push(bytes);
  }

  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** Build a minimal GGUF file image: a key-value header and optional tensor infos. */
export function ggufBytes(fixture: GgufFixture): Uint8Array {
  const w = new ByteWriter();
  const values: [string, GgufFixtureValue][] = [
    ["general.architecture", fixture.architecture],
    ...Object.entries(fixture.values ?? {}),
  ];
  const kvCount = values.length + (fixture.stringArray ? 1 : 0);
  w.u32(0x46554747);
  w.u32(fixture.version ?? 3);
  w.u64(fixture.tensors?.length ?? 0);
  w.u64(kvCount);
  for (const [key, value] of values) {
    w.string(key);
    if (typeof value === "string") {
      w.u32(8);
      w.string(value);
    } else if (typeof value === "boolean") {
      w.u32(7);
      w.u8(value ? 1 : 0);
    } else if (typeof value === "bigint") {
      w.u32(10);
      w.u64(value);
    } else if (Number.isInteger(value)) {
      w.u32(4);
      w.u32(value);
    } else {
      w.u32(6);
      w.f32(value);
    }
  }
  if (fixture.stringArray) {
    w.string(fixture.stringArray.key);
    w.u32(9);
    w.u32(8);
    w.u64(fixture.stringArray.count);
    for (let i = 0; i < fixture.stringArray.count; i += 1) w.string(`token-${i}`);
  }
  for (const name of fixture.tensors ?? []) {
    w.string(name);
    w.u32(1); // n_dims
    w.u64(1);
    w.u32(0); // F32
    w.u64(0); // data offset
  }
  return w.bytes();
}

export async function writeGgufFixture(file: string, fixture: GgufFixture): Promise<void> {
  await writeFile(file, ggufBytes(fixture));
}
