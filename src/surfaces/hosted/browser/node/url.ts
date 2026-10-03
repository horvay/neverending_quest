/** `node:url` for the browser bundle. */
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new globalThis.URL(url).pathname);
}
export function pathToFileURL(p: string): URL {
  return new globalThis.URL(`file://${encodeURI(p)}`);
}
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL };
