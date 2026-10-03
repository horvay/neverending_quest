import type { HttpServerRequest } from "@effect/platform";

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

function hostnameOf(host: string): string {
  return host.split(":")[0] ?? "";
}

/**
 * CSRF guard for state-changing routes.
 *
 * The request must carry a `Host` and an `http:` `Origin`. When the server is
 * reached over loopback (`127.0.0.1` / `localhost`) either loopback spelling
 * is accepted, since the two are the same machine. When the server is reached
 * by any other host — a LAN address, for `nq serve --host 0.0.0.0` — the
 * Origin must match the `Host` header exactly, so only the page this server
 * handed out can post back to it.
 */
export function sameOriginOk(req: HttpServerRequest.HttpServerRequest): boolean {
  const host = req.headers.host ?? "";
  const hostname = hostnameOf(host);
  if (!hostname) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (LOOPBACK.has(hostname)) {
    if (!LOOPBACK.has(url.hostname)) return false;
    return url.host === host || url.hostname === hostname;
  }
  return url.host === host;
}
