/** Bun's Request/fetch, stashed in `tests/preload_native.ts` before happy-dom. */
const g = globalThis as typeof globalThis & {
  __nqNativeRequest?: typeof Request;
  __nqNativeFetch?: typeof fetch;
  __nqNativeAbortController?: typeof AbortController;
  __nqNativeAbortSignal?: typeof AbortSignal;
};

export const NativeRequest = g.__nqNativeRequest ?? globalThis.Request;
export const nativeFetch = g.__nqNativeFetch ?? globalThis.fetch;
export const NativeAbortController =
  g.__nqNativeAbortController ?? globalThis.AbortController;
export const NativeAbortSignal =
  g.__nqNativeAbortSignal ?? globalThis.AbortSignal;
