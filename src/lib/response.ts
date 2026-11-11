import { beforeDeadline } from "./deadline";
import { fail } from "./errors";
export { fail, object } from "./errors";

export async function readText(response: Response, maxBytes = 2 * 1024 * 1024, signal = AbortSignal.timeout(45_000)): Promise<string> {
  if (!response.body) fail("WHO returned no body", 502);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) fail("WHO response exceeds byte limit", 502);
    while (true) {
      const { done, value } = await beforeDeadline(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) fail(`WHO response exceeds ${maxBytes} bytes; narrow the query`, 502);
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const bom = joined[0] === 0xef && joined[1] === 0xbb && joined[2] === 0xbf;
    return (bom ? "\uFEFF" : "") + new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(joined);
  } catch { fail(`WHO response unreadable, timed out or exceeds ${maxBytes} bytes`, 502); }
  finally { void reader.cancel().catch(() => undefined); }
}
