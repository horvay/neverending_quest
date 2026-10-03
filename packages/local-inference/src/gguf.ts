import { open, type FileHandle } from "node:fs/promises";
import { modelQuirks } from "./quirks.ts";
import { ggufSamplingDefaults, type LocalTuning } from "./tuning.ts";

/**
 * Minimal GGUF header reader. Parses the key-value section and the tensor
 * names that follow it, which is what NQ needs to learn a model's
 * architecture, its KV cache layout, and whether it carries
 * multi-token-prediction layers. Arrays are skipped, not materialized, so a
 * 100 GB file costs a few MB of reads at most.
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const enum GgufType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

const SCALAR_SIZE: Readonly<Record<number, number>> = {
  [GgufType.UINT8]: 1,
  [GgufType.INT8]: 1,
  [GgufType.UINT16]: 2,
  [GgufType.INT16]: 2,
  [GgufType.UINT32]: 4,
  [GgufType.INT32]: 4,
  [GgufType.FLOAT32]: 4,
  [GgufType.BOOL]: 1,
  [GgufType.UINT64]: 8,
  [GgufType.INT64]: 8,
  [GgufType.FLOAT64]: 8,
};

export type GgufScalar = number | bigint | boolean | string;

export type GgufHeader = {
  version: number;
  tensorCount: bigint;
  architecture?: string;
  /** Scalar metadata values by key. Arrays are not included. */
  values: ReadonlyMap<string, GgufScalar>;
  /** Array metadata by key, recorded as element count only. */
  arrayLengths: ReadonlyMap<string, bigint>;
  tensorNames: ReadonlySet<string>;
};

export class NotGgufError extends Error {
  constructor(file: string, reason: string) {
    super(`${file} is not a readable GGUF file: ${reason}`);
    this.name = "NotGgufError";
  }
}

const CHUNK = 256 * 1024;
const MAX_STRING = 64 * 1024 * 1024;

class FileCursor {
  private buffer = new Uint8Array(0);
  private view = new DataView(this.buffer.buffer);
  private bufferStart = 0;
  private position = 0;
  private eof = false;

  constructor(private readonly handle: FileHandle) {}

  get offset(): number {
    return this.position;
  }

  private async ensure(size: number): Promise<number> {
    const end = this.position + size;
    if (
      this.position >= this.bufferStart &&
      end <= this.bufferStart + this.buffer.length
    ) {
      return this.position - this.bufferStart;
    }
    if (this.eof) throw new Error("unexpected end of file");
    const length = Math.max(CHUNK, size);
    const fresh = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(
        fresh,
        filled,
        length - filled,
        this.position + filled,
      );
      if (bytesRead === 0) {
        this.eof = true;
        break;
      }
      filled += bytesRead;
    }
    if (filled < size) throw new Error("unexpected end of file");
    this.buffer = fresh.subarray(0, filled);
    this.view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );
    this.bufferStart = this.position;
    return 0;
  }

  skip(size: number | bigint): void {
    const n = Number(size);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("invalid skip length");
    this.position += n;
  }

  async u8(): Promise<number> {
    const at = await this.ensure(1);
    this.position += 1;
    return this.view.getUint8(at);
  }

  async u32(): Promise<number> {
    const at = await this.ensure(4);
    this.position += 4;
    return this.view.getUint32(at, true);
  }

  async i32(): Promise<number> {
    const at = await this.ensure(4);
    this.position += 4;
    return this.view.getInt32(at, true);
  }

  async u64(): Promise<bigint> {
    const at = await this.ensure(8);
    this.position += 8;
    return this.view.getBigUint64(at, true);
  }

  async i64(): Promise<bigint> {
    const at = await this.ensure(8);
    this.position += 8;
    return this.view.getBigInt64(at, true);
  }

  async f32(): Promise<number> {
    const at = await this.ensure(4);
    this.position += 4;
    return this.view.getFloat32(at, true);
  }

  async f64(): Promise<number> {
    const at = await this.ensure(8);
    this.position += 8;
    return this.view.getFloat64(at, true);
  }

  async string(): Promise<string> {
    const length = await this.u64();
    if (length > BigInt(MAX_STRING)) throw new Error("string too long");
    const size = Number(length);
    const at = await this.ensure(size);
    this.position += size;
    return new TextDecoder().decode(this.buffer.subarray(at, at + size));
  }
}

async function readScalar(
  cursor: FileCursor,
  type: number,
): Promise<GgufScalar> {
  switch (type) {
    case GgufType.UINT8:
      return cursor.u8();
    case GgufType.INT8:
      return ((await cursor.u8()) << 24) >> 24;
    case GgufType.UINT16: {
      const lo = await cursor.u8();
      const hi = await cursor.u8();
      return lo | (hi << 8);
    }
    case GgufType.INT16: {
      const lo = await cursor.u8();
      const hi = await cursor.u8();
      return ((lo | (hi << 8)) << 16) >> 16;
    }
    case GgufType.UINT32:
      return cursor.u32();
    case GgufType.INT32:
      return cursor.i32();
    case GgufType.FLOAT32:
      return cursor.f32();
    case GgufType.BOOL:
      return (await cursor.u8()) !== 0;
    case GgufType.STRING:
      return cursor.string();
    case GgufType.UINT64:
      return cursor.u64();
    case GgufType.INT64:
      return cursor.i64();
    case GgufType.FLOAT64:
      return cursor.f64();
    default:
      throw new Error(`unknown metadata value type ${type}`);
  }
}

async function skipArray(cursor: FileCursor): Promise<bigint> {
  const elementType = await cursor.u32();
  const count = await cursor.u64();
  const size = SCALAR_SIZE[elementType];
  if (size !== undefined) {
    cursor.skip(count * BigInt(size));
    return count;
  }
  if (elementType === GgufType.STRING) {
    for (let i = 0n; i < count; i += 1n) {
      const length = await cursor.u64();
      cursor.skip(length);
    }
    return count;
  }
  if (elementType === GgufType.ARRAY) {
    for (let i = 0n; i < count; i += 1n) await skipArray(cursor);
    return count;
  }
  throw new Error(`unknown array element type ${elementType}`);
}

/** Read the GGUF key-value header of a local file. */
export async function readGgufHeader(file: string): Promise<GgufHeader> {
  const handle = await open(file, "r");
  try {
    const cursor = new FileCursor(handle);
    let magic: number;
    try {
      magic = await cursor.u32();
    } catch {
      throw new NotGgufError(file, "file is shorter than a GGUF header");
    }
    if (magic !== GGUF_MAGIC)
      throw new NotGgufError(file, "missing GGUF magic");
    const version = await cursor.u32();
    if (version < 2 || version > 3) {
      throw new NotGgufError(file, `unsupported GGUF version ${version}`);
    }
    const tensorCount = await cursor.u64();
    const kvCount = await cursor.u64();
    const values = new Map<string, GgufScalar>();
    const arrayLengths = new Map<string, bigint>();
    const tensorNames = new Set<string>();
    try {
      for (let i = 0n; i < kvCount; i += 1n) {
        const key = await cursor.string();
        const type = await cursor.u32();
        if (type === GgufType.ARRAY) {
          arrayLengths.set(key, await skipArray(cursor));
        } else {
          values.set(key, await readScalar(cursor, type));
        }
      }
      for (let i = 0n; i < tensorCount; i += 1n) {
        tensorNames.add(await cursor.string());
        const dims = await cursor.u32();
        cursor.skip(dims * 8 + 4 + 8); // dims, type, data offset
      }
    } catch (error) {
      throw new NotGgufError(
        file,
        error instanceof Error ? error.message : String(error),
      );
    }
    const architecture = values.get("general.architecture");
    return {
      version,
      tensorCount,
      ...(typeof architecture === "string" ? { architecture } : {}),
      values,
      arrayLengths,
      tensorNames,
    };
  } finally {
    await handle.close();
  }
}

export type ModelMtpInspection = {
  file: string;
  /** Undefined when the file is not a GGUF file. */
  architecture?: string;
  /** `<arch>.nextn_predict_layers` (Qwen NextN, DeepSeek, GLM). */
  nextnLayers: number;
  /** `<arch>.mtp.num_layers` (LongCat Flash). */
  mtpNumLayers: number;
  supported: boolean;
  /** Human-readable reason for `supported`. */
  detail: string;
};

function integerValue(value: GgufScalar | undefined): number {
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/**
 * Decide from the GGUF header whether Atomic can run multi-token prediction
 * on this file. Mirrors llama.cpp: `n_layer_nextn > 0` for NextN models, and
 * LongCat Flash's three-step replicated MTP module.
 */
export async function inspectModelMtp(
  file: string,
): Promise<ModelMtpInspection> {
  let header: GgufHeader;
  try {
    header = await readGgufHeader(file);
  } catch (error) {
    if (error instanceof NotGgufError) {
      return {
        file,
        nextnLayers: 0,
        mtpNumLayers: 0,
        supported: false,
        detail: error.message,
      };
    }
    throw error;
  }
  const arch = header.architecture;
  if (!arch) {
    return {
      file,
      nextnLayers: 0,
      mtpNumLayers: 0,
      supported: false,
      detail: "GGUF header has no general.architecture",
    };
  }
  const nextnLayers = integerValue(
    header.values.get(`${arch}.nextn_predict_layers`),
  );
  const mtpNumLayers = integerValue(
    header.values.get(`${arch}.mtp.num_layers`),
  );
  const quirks = modelQuirks(arch);
  const blockCount = integerValue(header.values.get(`${arch}.block_count`));
  const mtpProbe = `blk.${blockCount - nextnLayers}.nextn.eh_proj.weight`;
  if (
    nextnLayers > 0 &&
    quirks.mtpNeedsNextnBlock &&
    !header.tensorNames.has(mtpProbe)
  ) {
    return {
      file,
      architecture: arch,
      nextnLayers,
      mtpNumLayers,
      supported: false,
      detail: `${arch}.nextn_predict_layers = ${nextnLayers} but the file has no ${mtpProbe}`,
    };
  }
  if (nextnLayers > 0) {
    return {
      file,
      architecture: arch,
      nextnLayers,
      mtpNumLayers,
      supported: true,
      detail: `${arch}.nextn_predict_layers = ${nextnLayers}`,
    };
  }
  if (quirks.longcatMtp) {
    const replicated =
      header.values.get(`${arch}.mtp.replicate_modules`) === true;
    const dsaCli = header.values.get(`${arch}.mtp.dsa_cli`) === true;
    if (mtpNumLayers === 3 && replicated && dsaCli) {
      return {
        file,
        architecture: arch,
        nextnLayers,
        mtpNumLayers,
        supported: true,
        detail: `${arch}.mtp.num_layers = 3 with replicated DSA module`,
      };
    }
    return {
      file,
      architecture: arch,
      nextnLayers,
      mtpNumLayers,
      supported: false,
      detail: `${arch} needs mtp.num_layers = 3 with replicate_modules and dsa_cli; found ${mtpNumLayers}`,
    };
  }
  return {
    file,
    architecture: arch,
    nextnLayers,
    mtpNumLayers,
    supported: false,
    detail: `${arch} header has no nextn_predict_layers`,
  };
}

export type ModelEngineInspection = {
  /** Undefined when the file is not a readable GGUF file. */
  architecture?: string;
  /**
   * llama.cpp stores K and V in one cache, so -ctk and -ctv must match.
   * Mirrors llama_init_from_model: MLA models
   * (`<arch>.attention.key_length_mla`) and the architectures `quirks.ts`
   * marks.
   */
  sharedKvCache: boolean;
  /** The model's own sampling recommendations (`general.sampling.*`). */
  sampling: LocalTuning;
  /** What the embedded chat template reads to steer thinking, if anything. */
  templateThinking?: TemplateThinking;
  /** Who the model says it is, for recognising its family. */
  identity: GgufIdentity;
};

/** The header's naming fields. Finetunes often keep their base in `baseModels`. */
export type GgufIdentity = {
  name?: string;
  basename?: string;
  finetune?: string;
  sizeLabel?: string;
  /** `general.base_model.N.name`, in header order. */
  baseModels: string[];
};

function ggufIdentity(values: ReadonlyMap<string, GgufScalar>): GgufIdentity {
  const text = (key: string) => {
    const value = values.get(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const baseModels: string[] = [];
  const count = integerValue(values.get("general.base_model.count"));
  for (let i = 0; i < Math.min(count, 16); i += 1) {
    const name = text(`general.base_model.${i}.name`);
    if (name) baseModels.push(name);
  }
  const name = text("general.name");
  const basename = text("general.basename");
  const finetune = text("general.finetune");
  const sizeLabel = text("general.size_label");
  return {
    ...(name ? { name } : {}),
    ...(basename ? { basename } : {}),
    ...(finetune ? { finetune } : {}),
    ...(sizeLabel ? { sizeLabel } : {}),
    baseModels,
  };
}

export type TemplateThinking = {
  /** The template reads `enable_thinking` (Qwen-style on/off switch). */
  toggle: boolean;
  /** The template reads `preserve_thinking` for earlier turns' reasoning. */
  preserve: boolean;
  /**
   * The `reasoning_effort` values the template accepts. It raises on any
   * other, and picks its own default (Qwen3.8: xhigh) when none is sent.
   */
  efforts?: string[];
};

/** Reads the thinking knobs out of a chat template (a GGUF's or an EXL3 folder's). */
export function templateThinking(template: string): TemplateThinking | undefined {
  const toggle = /\benable_thinking\b/.test(template);
  const preserve = /\bpreserve_thinking\b/.test(template);
  // Qwen3.8: `{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}`
  const allowed = /reasoning_effort\s+not\s+in\s+[([]([^)\]]*)[)\]]/.exec(template);
  const efforts = allowed
    ? [...allowed[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    : [];
  if (!toggle && !preserve && efforts.length === 0) return undefined;
  return { toggle, preserve, ...(efforts.length > 0 ? { efforts } : {}) };
}

/** What the engine launch must respect about this model, from its GGUF header. */
export async function inspectModelEngine(
  file: string,
): Promise<ModelEngineInspection> {
  let header: GgufHeader;
  try {
    header = await readGgufHeader(file);
  } catch (error) {
    if (error instanceof NotGgufError) {
      return { sharedKvCache: false, sampling: {}, identity: { baseModels: [] } };
    }
    throw error;
  }
  const sampling = ggufSamplingDefaults(header.values);
  const template = header.values.get("tokenizer.chat_template");
  const thinking =
    typeof template === "string" ? templateThinking(template) : undefined;
  const identity = ggufIdentity(header.values);
  const arch = header.architecture;
  if (!arch) return { sharedKvCache: false, sampling, identity };
  return {
    architecture: arch,
    sampling,
    identity,
    ...(thinking ? { templateThinking: thinking } : {}),
    sharedKvCache:
      modelQuirks(arch).sharedKvCache === true ||
      integerValue(header.values.get(`${arch}.attention.key_length_mla`)) > 0,
  };
}
