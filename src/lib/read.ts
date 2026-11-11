import type { Icd11Env } from "./http";
import { redactCredentialEcho } from "./http";
import { fail, readText } from "./response";

/** Evidence for the complete received body; credentials are never returned. */
export async function readIcd11Json(response: Response, env: Icd11Env, sourceUrl: string, request: unknown, signal: AbortSignal) {
  const original = await readText(response, 2 * 1024 * 1024, signal);
  const bytes = new TextEncoder().encode(original);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const raw = redactCredentialEcho(original, env, response);
  const provenance = {
    source_url: sourceUrl, request, retrieved_at: new Date().toISOString(),
    response_sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    response_bytes: bytes.byteLength, raw_json: raw, redacted: original !== raw,
  };
  const retry = response.headers.get("retry-after");
  const evidence = { upstream_http_status: response.status, retry_after: retry === null ? null : redactCredentialEcho(retry, env, response), provenance };
  if (response.status !== 200 || response.headers.has("content-range")) fail(`WHO API returned HTTP ${response.status}`, response.status === 200 ? 502 : response.status, evidence);
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { fail("WHO API returned invalid JSON", 502, evidence); }
  if (raw !== original) fail("WHO response contained authentication material and was withheld", 502, evidence);
  return { status: response.status, data, provenance };
}
