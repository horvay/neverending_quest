import * as readline from "node:readline";
import {
  deleteCampaign,
  newCampaign,
  showCampaign,
  type DeleteCampaignInfo,
} from "../campaign/index.ts";
import { fail } from "./fail.ts";

export async function runNew(args: string[]): Promise<number> {
  let pathArg: string | undefined;
  let pack: string | undefined;
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pack") {
      pack = args[++i];
      continue;
    }
    if (a === "--name") {
      name = args[++i];
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return 1;
    }
    if (pathArg !== undefined) {
      console.error(`Unexpected argument: ${a}`);
      return 1;
    }
    pathArg = a;
  }

  if (!pathArg || !pack) {
    console.error("Usage: nq new <path> --pack <dir> [--name <display-name>]");
    return 1;
  }

  try {
    const meta = await newCampaign({ path: pathArg, packDir: pack, name });
    console.log(`Created Campaign "${meta.name}" (${meta.id}) at ${pathArg}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export async function runDelete(args: string[]): Promise<number> {
  let pathArg: string | undefined;
  let skipConfirm = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "-y") {
      skipConfirm = true;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return 1;
    }
    if (pathArg !== undefined) {
      console.error(`Unexpected argument: ${a}`);
      return 1;
    }
    pathArg = a;
  }

  try {
    const result = await deleteCampaign({
      path: pathArg,
      confirm: async (info) => {
        if (skipConfirm) return true;
        return confirmCampaignDelete(info);
      },
    });
    if (!result.deleted) {
      console.error("Cancelled — Campaign not deleted.");
      return 1;
    }
    console.log(
      `Deleted Campaign "${result.meta.name}" (${result.meta.id}) at ${result.path}`,
    );
    return 0;
  } catch (err) {
    return fail(err);
  }
}

async function confirmCampaignDelete(
  info: DeleteCampaignInfo,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Refusing to delete without confirmation. Re-run in a terminal, or pass --yes.",
    );
  }
  const prompt =
    `Permanently delete Campaign "${info.meta.name}" (${info.meta.id})?\n` +
    `Path: ${info.path}\n` +
    `This cannot be undone. Are you sure? [y/N] `;
  const answer = await questionOnStderr(prompt);
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

export function questionOnStderr(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY,
    });
    rl.question(prompt, (value) => {
      rl.close();
      resolve(value);
    });
  });
}

export async function runShow(args: string[]): Promise<number> {
  let pathArg: string | undefined;
  let target: string | undefined;
  let dossierSlug: string | undefined;

  for (const a of args) {
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      return 1;
    }
    if (pathArg === undefined && target === undefined && looksLikePath(a)) {
      pathArg = a;
      continue;
    }
    if (target === undefined) {
      target = a;
      continue;
    }
    if (target === "dossiers" && dossierSlug === undefined) {
      dossierSlug = a;
      continue;
    }
    console.error(`Unexpected argument: ${a}`);
    return 1;
  }

  try {
    const result = await showCampaign({ path: pathArg, target, dossierSlug });
    process.stdout.write(
      result.text.endsWith("\n") ? result.text : `${result.text}\n`,
    );
    return 0;
  } catch (err) {
    return fail(err);
  }
}

function looksLikePath(s: string): boolean {
  return (
    s.includes("/") ||
    s.includes("\\") ||
    s === "." ||
    s === ".." ||
    s.startsWith("./") ||
    s.startsWith("../")
  );
}
