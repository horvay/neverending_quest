import { describe, expect, test } from "bun:test";
import path from "node:path";
import { freePort, runCli } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

function runNq(root: string, args: string[]) {
  return runCli(args, {
    env: {
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
  });
}

describe("nq local CLI", () => {
  test("documents the managed local runtime commands", async () => {
    const root = await makeTempDir();
    try {
      const result = await runNq(root, ["--help"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("nq local download");
      expect(result.stdout).toContain("nq local install");
      expect(result.stdout).toContain("path|url|owner/repository");
      expect(result.stdout).toContain("--reasoning-tokens <n>");
    } finally {
      await rmTempDir(root);
    }
  });

  test("inspects a local GGUF before installation", async () => {
    const root = await makeTempDir();
    try {
      const model = path.join(root, "quest-model.gguf");
      await Bun.write(model, "model fixture");

      const result = await runNq(root, ["local", "inspect", "--model", model]);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("quest-model.gguf");
    } finally {
      await rmTempDir(root);
    }
  });

  test("downloads a verified model without installing a runtime", async () => {
    const root = await makeTempDir();
    const bytes = new TextEncoder().encode("download command model fixture");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(bytes);
      },
    });
    try {
      const result = await runNq(root, [
        "local",
        "download",
        "--model",
        `http://127.0.0.1:${server.port}/extra-mtp.gguf`,
        "--model-sha256",
        sha256,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Downloaded extra-mtp.gguf.");
      expect(result.stdout).toContain("extra-mtp.gguf");
      const status = await runNq(root, ["local", "status", "--port", String(freePort()), "--json"]);
      expect(JSON.parse(status.stdout).installed).toBe(false);
    } finally {
      server.stop(true);
      await rmTempDir(root);
    }
  });

  test("reports an isolated uninstalled runtime as JSON", async () => {
    const root = await makeTempDir();
    try {
      const port = freePort();
      const result = await runNq(root, ["local", "status", "--port", String(port), "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        state: "not-installed",
        endpoint: `http://127.0.0.1:${port}`,
        installed: false,
      });
    } finally {
      await rmTempDir(root);
    }
  });

  test("requires confirmation before uninstalling non-interactively", async () => {
    const root = await makeTempDir();
    try {
      const result = await runNq(root, ["local", "uninstall"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("without confirmation");
    } finally {
      await rmTempDir(root);
    }
  });
});
