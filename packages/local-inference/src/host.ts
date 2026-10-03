/**
 * The Local Inference Host: one detached process per machine that owns the
 * local engine, proxies the Game Master's requests to it, hands the GPU to
 * the painter between Turns, and exits once no nq process holds a lease.
 *
 *   host/record.ts     the host's record file, start lock, and pid checks
 *   host/client.ts     what an nq process uses to start and talk to the host
 *   host/server.ts     the host process: control routes and the text proxy
 *   host/installed.ts  questions about the local installation
 */
export * from "./host/client.ts";
export * from "./host/installed.ts";
export * from "./host/record.ts";
export * from "./host/server.ts";
