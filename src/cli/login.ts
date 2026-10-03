import { access } from "node:fs/promises";
import * as path from "node:path";
import {
  configureNqLogin,
  parseOmpModels,
  parseOmpProviders,
} from "../login.ts";
import { selectInteractiveChoice } from "../surfaces/tui/terminal_picker.ts";
import { fail } from "./fail.ts";
import { prepareModelRuntime } from "./play.ts";

export async function runLogin(
  args: string[],
  configPath: string,
  oneShotModel: string | undefined,
): Promise<number> {
  if (oneShotModel) {
    console.error(
      "`--model` applies only to one `nq play` or `nq turn` command. Use the login model picker to change NQ's saved model.",
    );
    return 1;
  }
  let provider: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--provider") {
      provider = args[++i];
      if (!provider) {
        console.error("Missing value for --provider.");
        return 1;
      }
      continue;
    }
    console.error(`Unknown login argument: ${arg}`);
    return 1;
  }

  // every login ends in an interactive model choice; fail before spawning OMP
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("`nq login` requires an interactive terminal.");
    return 1;
  }

  try {
    const result = await configureNqLogin({
      configPath,
      provider,
      providers: async () =>
        parseOmpProviders(await runOmpJson(["auth-broker", "list", "--json"])),
      authenticate: async (selected) => {
        await runOmpInteractive(["auth-broker", "login", selected]);
      },
      models: async () =>
        parseOmpModels(await runOmpJson(["models", "--json"])),
      choose: selectInteractiveChoice,
      prepareModel: (model) => prepareModelRuntime(model),
    });
    console.log(`Game Master model set: ${result.model}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

async function ompCliPath(): Promise<string> {
  let dir = import.meta.dir;
  for (;;) {
    const candidate = path.join(
      dir,
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep walking to model Node's ancestor node_modules lookup.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Bundled OMP CLI not found. Reinstall Neverending Quest dependencies.",
      );
    }
    dir = parent;
  }
}

async function runOmpJson(args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, await ompCliPath(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `OMP command failed: ${args.join(" ")}`);
  }
  return stdout;
}

async function runOmpInteractive(args: string[]): Promise<void> {
  const proc = Bun.spawn([process.execPath, await ompCliPath(), ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`OMP login failed: ${args.join(" ")}`);
  }
}
