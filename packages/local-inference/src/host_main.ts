/**
 * Entry point of the detached Local Inference Host process. The client spawns
 * `bun host_main.ts __local-inference-host <rootDir> <port> <enginePort> <token>`
 * and keeps the record; the marker argument names the process in `ps`.
 */
import { runLocalInferenceHostProcess } from "./host.ts";

async function main(args: string[]): Promise<number> {
  const [marker, rootDir, portRaw, enginePortRaw, token] = args;
  const port = Number(portRaw);
  const enginePort = Number(enginePortRaw);
  if (
    marker !== "__local-inference-host" ||
    !rootDir ||
    !Number.isInteger(port) ||
    !Number.isInteger(enginePort) ||
    !token
  ) {
    console.error("Invalid local inference host launch.");
    return 1;
  }
  try {
    return await runLocalInferenceHostProcess({ rootDir, port, enginePort, token });
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
