import { type } from "@oh-my-pi/pi-ai";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ModelRole = "model" | "mtp";

export type ModelCandidate = {
  id: string;
  label: string;
  files: string[];
  size?: number;
};

export type ModelFileMetadata = {
  sha256?: string;
  size?: number;
};

export type ModelInspection = {
  source: string;
  kind: "path" | "url" | "huggingface";
  repository?: string;
  revision?: string;
  fileMetadata?: Record<string, ModelFileMetadata>;
  candidates: ModelCandidate[];
};

export type ResolvedModelFile = {
  name: string;
  localPath?: string;
  url?: string;
  sha256?: string;
  size?: number;
  headers?: Record<string, string>;
};

export type ResolvedModelSource = {
  source: string;
  kind: ModelInspection["kind"];
  label: string;
  files: ResolvedModelFile[];
};

export type LocalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ModelSelectionRequiredError extends Error {
  readonly inspection: ModelInspection;

  constructor(inspection: ModelInspection) {
    super(
      `Model source ${inspection.source} contains multiple GGUF choices. Select one with --model-file.`,
    );
    this.name = "ModelSelectionRequiredError";
    this.inspection = inspection;
  }
}

export type ModelSourceOptions = {
  role?: ModelRole;
  file?: string;
  sha256?: string;
  fetch?: LocalFetch;
  hfToken?: string;
};
const HuggingFaceLfsSchema = type({
  sha256: "string",
  size: "number",
  "+": "delete",
});
const HuggingFaceSiblingSchema = type({
  rfilename: "string",
  "size?": "number",
  "lfs?": HuggingFaceLfsSchema,
  "+": "delete",
});
const HuggingFaceResponseSchema = type({
  "sha?": "string",
  "siblings?": HuggingFaceSiblingSchema.array(),
  "+": "delete",
});

export async function inspectModelSource(
  source: string,
  opts: ModelSourceOptions = {},
): Promise<ModelInspection> {
  const clean = source.trim();
  if (!clean) throw new Error("Model source is empty.");
  const role = opts.role ?? "model";
  const localPath = await resolveExistingLocalFile(clean);
  if (localPath) {
    const info = await stat(localPath);
    return {
      source: clean,
      kind: "path",
      candidates: [
        {
          id: localPath,
          label: path.basename(localPath),
          files: [localPath],
          size: info.size,
        },
      ],
    };
  }
  const hf = parseHuggingFaceSource(clean);
  if (hf) {
    const fetchImpl = opts.fetch ?? fetch;
    const headers = huggingFaceHeaders(opts.hfToken);
    const response = await fetchImpl(
      `https://huggingface.co/api/models/${encodeURIComponent(hf.owner)}/${encodeURIComponent(hf.repo)}?blobs=true`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(
        `Hugging Face model lookup failed (${response.status}) for ${hf.owner}/${hf.repo}.` +
          (response.status === 401
            ? " Set HF_TOKEN if this repository requires access."
            : ""),
      );
    }
    const body = HuggingFaceResponseSchema.assert(await response.json());
    const revision = body.sha || "main";
    const siblings = body.siblings ?? [];
    const filenames = siblings.map((item) => item.rfilename);
    const fileMetadata: Record<string, ModelFileMetadata> = {};
    const sizeByFilename = new Map<string, number>();
    for (const item of siblings) {
      const size = item.lfs?.size ?? item.size;
      const sha256 = normalizeSha256(item.lfs?.sha256);
      if (size !== undefined) sizeByFilename.set(item.rfilename, size);
      if (size !== undefined || sha256) {
        fileMetadata[item.rfilename] = {
          ...(sha256 ? { sha256 } : {}),
          ...(size !== undefined ? { size } : {}),
        };
      }
    }
    const explicitFile = opts.file ?? hf.file;
    const candidates = explicitFile
      ? candidatesForExplicitFile(filenames, explicitFile, sizeByFilename)
      : groupGgufCandidates(filenames, role, sizeByFilename);
    if (candidates.length === 0) {
      const qualifier = explicitFile ? ` matching ${explicitFile}` : "";
      throw new Error(
        `Hugging Face repository ${hf.owner}/${hf.repo} has no GGUF file${qualifier}.`,
      );
    }
    return {
      source: clean,
      kind: "huggingface",
      repository: `${hf.owner}/${hf.repo}`,
      revision,
      candidates,
      ...(Object.keys(fileMetadata).length > 0 ? { fileMetadata } : {}),
    };
  }
  if (/^https?:\/\//i.test(clean)) {
    const url = new URL(clean);
    const name =
      decodeURIComponent(path.posix.basename(url.pathname)) || "model.gguf";
    return {
      source: clean,
      kind: "url",
      candidates: [{ id: clean, label: name, files: [clean] }],
    };
  }
  if (looksLikeExplicitPath(clean)) {
    throw new Error(`Model file does not exist: ${expandLocalPath(clean)}`);
  }
  throw new Error(
    "Model must be a local GGUF path, an HTTP(S) URL, or a Hugging Face owner/repository identifier or repository URL.",
  );
}

export async function resolveModelSource(
  source: string,
  opts: ModelSourceOptions = {},
): Promise<ResolvedModelSource> {
  const inspection = await inspectModelSource(source, opts);
  if (inspection.candidates.length !== 1) {
    throw new ModelSelectionRequiredError(inspection);
  }
  const candidate = inspection.candidates[0]!;
  if (inspection.kind === "path") {
    return {
      source,
      kind: "path",
      label: candidate.label,
      files: candidate.files.map((localPath) => ({
        name: path.basename(localPath),
        localPath,
        size: candidate.size,
      })),
    };
  }
  const fetchImpl = opts.fetch ?? fetch;
  if (inspection.kind === "url") {
    const suppliedSha256 = normalizeSha256(opts.sha256);
    let metadata: { sha256?: string; size?: number } = {};
    try {
      metadata = await remoteFileMetadata(candidate.files[0]!, fetchImpl, {});
    } catch (error) {
      if (!suppliedSha256) throw error;
    }
    const sha256 = suppliedSha256 ?? metadata.sha256;
    if (!sha256) {
      const checksumFlag =
        opts.role === "mtp" ? "--mtp-sha256" : "--model-sha256";
      throw new Error(
        `The model URL does not publish a SHA-256 digest. Pass ${checksumFlag} so NQ can verify the download.`,
      );
    }
    return {
      source,
      kind: "url",
      label: candidate.label,
      files: [
        {
          name: candidate.label,
          url: candidate.files[0]!,
          sha256,
          size: metadata.size,
        },
      ],
    };
  }
  const repository = inspection.repository!;
  const revision = inspection.revision!;
  const headers = huggingFaceHeaders(opts.hfToken);
  const files: ResolvedModelFile[] = [];
  for (const filename of candidate.files) {
    const encodedFile = filename.split("/").map(encodeURIComponent).join("/");
    const url = `https://huggingface.co/${repository}/resolve/${revision}/${encodedFile}?download=true`;
    const published = inspection.fileMetadata?.[filename];
    const metadata = published?.sha256
      ? published
      : {
          ...published,
          ...(await remoteFileMetadata(url, fetchImpl, headers)),
        };
    if (!metadata.sha256) {
      throw new Error(
        `Hugging Face did not publish a SHA-256 digest for ${filename}.`,
      );
    }
    files.push({
      name: filename,
      url,
      sha256: metadata.sha256,
      size: metadata.size,
      ...(Object.keys(headers).length > 0 ? { headers: { ...headers } } : {}),
    });
  }
  return {
    source,
    kind: "huggingface",
    label: candidate.label,
    files,
  };
}

function parseHuggingFaceSource(
  source: string,
): { owner: string; repo: string; file?: string } | undefined {
  const match = /^([^/:\s]+)\/([^/:\s]+)(?::(.+))?$/.exec(source);
  if (match) {
    return {
      owner: match[1]!,
      repo: match[2]!,
      ...(match[3] ? { file: match[3] } : {}),
    };
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co")
    return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined;
  return { owner: segments[0]!, repo: segments[1]! };
}

function candidatesForExplicitFile(
  filenames: string[],
  requested: string,
  sizeByFilename: ReadonlyMap<string, number>,
): ModelCandidate[] {
  if (!filenames.includes(requested)) return [];
  const shard = parseShardName(requested);
  if (!shard) {
    const size = sizeByFilename.get(requested);
    return [
      {
        id: requested,
        label: requested,
        files: [requested],
        ...(size !== undefined ? { size } : {}),
      },
    ];
  }
  const files = filenames
    .filter((name) => {
      const part = parseShardName(name);
      return part?.group === shard.group && part.total === shard.total;
    })
    .sort();
  const size = candidateSize(files, sizeByFilename);
  return [
    {
      id: files[0]!,
      label: shard.group,
      files,
      ...(size !== undefined ? { size } : {}),
    },
  ];
}

function groupGgufCandidates(
  filenames: string[],
  role: ModelRole,
  sizeByFilename: ReadonlyMap<string, number>,
): ModelCandidate[] {
  const eligible = filenames.filter((name) => {
    const base = path.posix.basename(name).toLowerCase();
    return base.endsWith(".gguf") && !base.startsWith("mmproj-");
  });
  const roleFiles = eligible.filter((name) =>
    role === "mtp" ? isMtpFilename(name) : !isMtpFilename(name),
  );
  const selected =
    roleFiles.length > 0 || role === "mtp"
      ? roleFiles
      : eligible.filter(isEmbeddedMtpFilename);
  const groups = new Map<string, string[]>();
  for (const filename of selected) {
    const shard = parseShardName(filename);
    const key = shard ? `${shard.group}|${shard.total}` : filename;
    const group = groups.get(key) ?? [];
    group.push(filename);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((files) => {
      files.sort();
      const first = files[0]!;
      const shard = parseShardName(first);
      const size = candidateSize(files, sizeByFilename);
      return {
        id: first,
        label: shard?.group ?? first,
        files,
        ...(size !== undefined ? { size } : {}),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function isMtpFilename(filename: string): boolean {
  const base = path.posix.basename(filename).toLowerCase();
  return base.startsWith("mtp-") || isEmbeddedMtpFilename(base);
}

function isEmbeddedMtpFilename(filename: string): boolean {
  const base = path.posix.basename(filename).toLowerCase();
  return base.includes("-mtp-") || base.endsWith("-mtp.gguf");
}

function candidateSize(
  files: string[],
  sizeByFilename: ReadonlyMap<string, number>,
): number | undefined {
  let total = 0;
  for (const file of files) {
    const size = sizeByFilename.get(file);
    if (size === undefined) return undefined;
    total += size;
  }
  return total;
}

function parseShardName(
  filename: string,
): { group: string; total: number } | undefined {
  const match = /^(.*?)-\d{5}-of-(\d{5})\.gguf$/i.exec(filename);
  if (!match) return undefined;
  return { group: match[1]!, total: Number(match[2]) };
}

async function remoteFileMetadata(
  url: string,
  fetchImpl: LocalFetch,
  headers: HeadersInit,
): Promise<{ sha256?: string; size?: number }> {
  const response = await fetchImpl(url, {
    method: "HEAD",
    headers,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Model download metadata failed (${response.status}) for ${url}.`,
    );
  }
  const digest =
    normalizeSha256(response.headers.get("x-linked-etag")) ??
    normalizeSha256(response.headers.get("etag")) ??
    normalizeSha256(response.headers.get("digest"));
  const rawSize =
    response.headers.get("x-linked-size") ??
    response.headers.get("content-length");
  const size = rawSize ? Number(rawSize) : undefined;
  return {
    ...(digest ? { sha256: digest } : {}),
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
  };
}

function normalizeSha256(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /(?:sha-?256[:=])?\s*["']?([a-f0-9]{64})["']?/i.exec(
    raw.trim(),
  );
  return match?.[1]?.toLowerCase();
}

function huggingFaceHeaders(explicitToken?: string): Record<string, string> {
  const token =
    explicitToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function resolveExistingLocalFile(
  source: string,
): Promise<string | undefined> {
  const candidate = source.startsWith("file:")
    ? fileURLToPath(source)
    : expandLocalPath(source);
  try {
    const info = await stat(candidate);
    return info.isFile() ? path.resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function expandLocalPath(source: string): string {
  if (source === "~") return os.homedir();
  if (source.startsWith(`~${path.sep}`) || source.startsWith("~/")) {
    return path.join(os.homedir(), source.slice(2));
  }
  return source;
}

function looksLikeExplicitPath(source: string): boolean {
  return (
    source.startsWith("file:") ||
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    source.toLowerCase().endsWith(".gguf")
  );
}
