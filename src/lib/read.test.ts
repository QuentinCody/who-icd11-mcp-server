/// <reference types="node" />
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { readText } from "./response";
import { beforeDeadline, boundedFetch } from "./deadline";
let api: ApiFetchFn;
let http: typeof import("./http");
const env = { ICD11_CLIENT_ID: "read-fixture-client", ICD11_CLIENT_SECRET: "read-fixture-secret+/" };
const bearer = "read-fixture-bearer+/";
const token = () => Response.json({ access_token: bearer, expires_in: 3600 });
const request = { method: "GET", path: "/entity" };
const lookup = { method: "GET", path: "/fhir/CodeSystem/$lookup", params: { system: "http://id.who.int/icd/release/11/mms", code: "1A00", version: "2025-01", displayLanguage: "es" } };
beforeEach(async () => { vi.resetModules(); http = await import("./http"); api = (await import("./api-adapter")).createIcd11ApiFetch(env); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(response: Response) { const fetcher = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetcher); return fetcher; }

it("preserves BOM, whitespace, Unicode and original byte hashes", async () => {
  const raw = '\uFEFF{ "availableLanguages": ["en", "es"], "extra": "α😀" }\r\n';
  setup(new Response(raw));
  expect(await api(request)).toMatchObject({ data: { availableLanguages: ["en", "es"], extra: "α😀", _mcp: { provenance: {
    raw_json: raw, response_sha256: createHash("sha256").update(raw).digest("hex"), response_bytes: Buffer.byteLength(raw), redacted: false,
  } } } });
});
it("applies traversal checks to paths while preserving punctuation in native query values", async () => {
  const fetcher = setup(Response.json({ destinationEntities: [] }));
  const params = { q: "family .. history", useFlexisearch: true };
  const result = await api({ method: "GET", path: "/entity/search", params });
  expect(result).toMatchObject({ status: 200, data: { destinationEntities: [] } });
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("q")).toBe(params.q);
});
it.each([206, 302, 429, 503])("preserves full HTTP %s evidence without following redirects or retrying", async status => {
  const raw = JSON.stringify({ diagnostics: "α".repeat(9000), code: "provider" }); const fetcher = setup(new Response(raw, { status, headers: { "retry-after": "12" } }));
  await expect(api(request)).rejects.toMatchObject({ status, data: { upstream_http_status: status, retry_after: "12", provenance: { raw_json: raw, response_bytes: Buffer.byteLength(raw) } } });
  expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][1].redirect).toBe("manual");
});
it.each([new Response("{}", { headers: { "content-range": "bytes 0-1/9" } }), new Response("{broken")])("rejects incomplete or invalid JSON while retaining its evidence %#", async response => {
  setup(response); await expect(api(request)).rejects.toMatchObject({ status: 502, data: { provenance: { raw_json: expect.any(String) } } });
});
it("retains the complete wrong-release FHIR resource and request context", async () => {
  const raw = { resourceType: "Parameters", parameter: [{ name: "version", valueString: "2026-01" }], unknown: "α".repeat(18000), _mcp: { native: true } };
  setup(Response.json(raw));
  await expect(api(lookup)).rejects.toMatchObject({ status: 409, data: { ...raw, _mcp: { provenance: { raw_json: JSON.stringify(raw), request: { language: "es", params: lookup.params } } }, validation_error: { requested_release: "2025-01", reported_versions: ["2026-01"] } } });
});
it.each([env.ICD11_CLIENT_SECRET, encodeURIComponent(env.ICD11_CLIENT_SECRET), bearer, Array.from(bearer).map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")])("redacts literal and encoded credential echoes without claiming success %#", async secret => {
  const raw = '{"diagnostic":"' + secret + '"}'; setup(new Response(raw));
  const error = await api(request).catch(error => error);
  expect(error.status).toBe(502); expect(error.data.provenance).toMatchObject({ raw_json: '{"diagnostic":"[REDACTED]"}', redacted: true, response_sha256: createHash("sha256").update(raw).digest("hex") });
});
it("redacts a token used by a response even after another credential pair rotates the cache", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(bearer)).mockResolvedValueOnce(Response.json({ access_token: "rotated-bearer", expires_in: 3600 })).mockResolvedValueOnce(new Response("{}")));
  const old = await http.icd11Fetch("/entity", env);
  await http.icd11Fetch("/entity", { ...env, ICD11_CLIENT_SECRET: "rotated-secret" });
  expect(http.redactCredentialEcho(bearer, env, old)).toBe("[REDACTED]");
});
it("enforces an already cancelled deadline", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(beforeDeadline(Promise.resolve("late"), abort.signal)).rejects.toMatchObject({ status: 502 });
});
it("bounds a header promise that ignores abort", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); const abort = new AbortController();
  const result = boundedFetch("https://id.who.int/icd/entity", { signal: abort.signal }); abort.abort();
  await expect(result).rejects.toMatchObject({ status: 502 });
});
it("bounds a stalled stream and does not wait for cancellation", async () => {
  const abort = new AbortController(); const response = new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }));
  const result = readText(response, 100, abort.signal); abort.abort(); await expect(result).rejects.toMatchObject({ status: 502 });
});
it.each([new Uint8Array([0xff]), new TextEncoder().encode("12345")])("rejects invalid UTF-8 or an oversized stream %#", async bytes => {
  await expect(readText(new Response(bytes), 4)).rejects.toMatchObject({ status: 502 });
});
it("shares the deadline through OAuth body reading", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }))));
  const abort = new AbortController(); const result = http.icd11Fetch("/entity", env, { signal: abort.signal });
  await Promise.resolve(); await Promise.resolve(); abort.abort(); await expect(result).rejects.toMatchObject({ status: 502 });
});
it.each([{ method: "POST", path: "/entity" }, { method: "GET", path: "/entity", body: {} }, { method: "GET", path: "/../token" }, { method: "GET", path: "/%2e%2e/token" }, { method: "GET", path: "/entity", params: { q: Number.NaN } }])("rejects unsupported or ambiguous requests before networking %#", async input => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(api(input)).rejects.toBeInstanceOf(Error); expect(fetcher).not.toHaveBeenCalled();
});
