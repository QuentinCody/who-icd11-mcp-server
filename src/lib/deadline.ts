import { fail } from "./errors";

/** Enforce the same deadline even when an upstream promise ignores cancellation. */
export async function beforeDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    fail("WHO request timed out or was cancelled", 502);
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Object.assign(new Error("WHO request timed out or was cancelled"), { status: 502 }));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function boundedFetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  if (init.signal.aborted) fail("WHO request timed out or was cancelled", 502);
  try {
    return await beforeDeadline(Promise.resolve(fetch(url, init)).then(response => {
      if (init.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        fail("WHO request timed out or was cancelled", 502);
      }
      return response;
    }), init.signal);
  } catch { fail("WHO request failed, timed out or was cancelled", 502); }
}
