import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { fhirInput, WHO_SYSTEMS } from "./fhir-input";
let api: ApiFetchFn;
const env = { ICD11_CLIENT_ID: "fixture-who-client-identifier", ICD11_CLIENT_SECRET: "fixture-who-client-secret" };
const params = { system: WHO_SYSTEMS[1], code: "1A00", version: "2025-01", displayLanguage: "es" };
const scale = "http://id.who.int/icd/release/11/2025-01/mms/257068234/postcoordinationScale/infectiousAgent";
const lookup = (version = "2025-01") => ({ resourceType: "Parameters", parameter: [{ name: "version", valueString: version }, { name: "designation", part: [{ name: "language", valueCode: "es" }, { name: "value", valueString: "Cólera" }] }, { name: "property", part: [{ name: "code", valueCode: "postcoordinationScale" }, { name: "value", valueUri: scale }] }] });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/fhir+json" } });
function setup(data: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "fixture-who-bearer-token", expires_in: 3600 })).mockResolvedValueOnce(json(data, status));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
beforeEach(async () => { vi.resetModules(); api = (await import("./api-adapter")).createIcd11ApiFetch(env); });
afterEach(() => vi.unstubAllGlobals());
it("routes FHIR beside /icd, retaining explicit release/language, properties and scale references", async () => {
  const raw = lookup(); const fetcher = setup(raw);
  const result = await api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params });
  expect(result).toMatchObject({ status: 200, data: { ...raw, _who_fhir: { prerelease: true, requested: { system: WHO_SYSTEMS[1], release: "2025-01", language: "es" }, lookup_release_verified: true } } });
  const url = new URL(fetcher.mock.calls[1][0]);
  expect(url.origin + url.pathname).toBe("https://id.who.int/fhir/CodeSystem/$lookup");
  expect(Object.fromEntries(url.searchParams)).toEqual(params);
  expect(fetcher.mock.calls[1][1].headers).toMatchObject({ "Accept-Language": "es", Accept: "application/fhir+json", Authorization: "Bearer fixture-who-bearer-token", "API-Version": "v2" });
  expect(JSON.stringify(result)).not.toContain("fixture-who-bearer-token");
});
it.each([lookup("2026-01"), { resourceType: "Parameters", parameter: [] }, { resourceType: "Parameters", parameter: [...lookup().parameter, { name: "version", valueString: "2024-01" }] }])("rejects missing or contradictory lookup release evidence %#", async raw => {
  setup(raw); await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 409 });
});
it("preserves distinct CodeSystem versions, translated extensions and Bundle links", async () => {
  const raw = { resourceType: "Bundle", total: 2, link: [{ relation: "next", url: "https://id.who.int/fhir/CodeSystem?fixture=next" }], entry: ["2025-01", "2026-01"].map(version => ({ resource: { resourceType: "CodeSystem", url: WHO_SYSTEMS[1], version, extension: [{ url: "translation", valueString: "Clasificación" }] } })) };
  const fetcher = setup(raw);
  expect(await api({ method: "GET", path: "/fhir/CodeSystem", params: { url: WHO_SYSTEMS[1], language: "es" } })).toMatchObject({ data: raw });
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.has("language")).toBe(false);
});
it.each([{}, { entry: [] }])("retains empty version searches without inventing availability %#", async entries => {
  setup({ resourceType: "Bundle", total: 0, ...entries });
  expect(await api({ method: "GET", path: "/fhir/CodeSystem", params: { url: WHO_SYSTEMS[1], version: "2026-01" } })).toMatchObject({ data: { total: 0, _who_fhir: { resource_version: null, version_note: expect.stringContaining("Empty searches do not establish availability") } } });
});
it.each([{ url: WHO_SYSTEMS[2], version: "2025-01" }, { url: WHO_SYSTEMS[1], version: "2026-01" }])("rejects ignored CodeSystem search selectors %#", async entry => {
  setup({ resourceType: "Bundle", entry: [{ resource: { resourceType: "CodeSystem", ...entry } }] });
  await expect(api({ method: "GET", path: "/fhir/CodeSystem", params: { url: WHO_SYSTEMS[1], version: "2025-01" } })).rejects.toMatchObject({ status: 409 });
});
it.each([true, false])("preserves validation result %s without inventing observed version evidence", async valueBoolean => {
  const raw = { resourceType: "Parameters", parameter: [{ name: "result", valueBoolean }, { name: "message", valueString: "provider diagnostic" }] }; setup(raw);
  expect(await api({ method: "GET", path: "/fhir/CodeSystem/$validate-code", params: { url: WHO_SYSTEMS[1], code: "1A00", version: "2025-01", language: "en" } })).toMatchObject({ data: { ...raw, _who_fhir: { reported_parameter_versions: [], lookup_release_verified: null } } });
});
it("retains postcoordination scale envelope and distinct underlying versions", async () => {
  const raw = { resourceType: "ValueSet", url: scale, version: "scale-revision-7", expansion: { identifier: "fixture", timestamp: "2026-09-28", total: 12, offset: 3, parameter: [{ name: "version", valueUri: `${WHO_SYSTEMS[1]}|2025-01` }], contains: [{ system: WHO_SYSTEMS[1], version: "2025-01", code: "XN62R", designation: [{ language: "en", value: "provider label" }] }] } };
  const fetcher = setup(raw);
  expect(await api({ method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale, displayLanguage: "en", count: 1, offset: 3 } })).toMatchObject({ data: { ...raw, _who_fhir: { resource_version: "scale-revision-7", requested: { release: "2025-01", system: WHO_SYSTEMS[1] } } } });
  expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("count")).toBe("1");
});
it("does not accept an expansion of a different scale", async () => {
  setup({ resourceType: "ValueSet", url: scale.replace("infectiousAgent", "associatedWith") });
  await expect(api({ method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale, displayLanguage: "en" } })).rejects.toMatchObject({ status: 409 });
});
it("exposes hierarchical expansion paging as unapplied without dropping nested terms", async () => {
  const raw = { resourceType: "ValueSet", url: scale, expansion: { contains: [{ abstract: true, contains: [{ system: WHO_SYSTEMS[1], code: "XN62R" }] }] } }; setup(raw);
  expect(await api({ method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale, displayLanguage: "en", count: 1, offset: 5 } })).toMatchObject({ data: { ...raw, _who_fhir: { expansion: { kind: "hierarchical", paging_honored: false, returned_total: null } } } });
});
it("rejects ignored flat-page offsets", async () => {
  setup({ resourceType: "ValueSet", url: scale, expansion: { contains: [] } });
  await expect(api({ method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale, displayLanguage: "en", offset: 3 } })).rejects.toMatchObject({ status: 409 });
});
it.each(["CapabilityStatement", "TerminologyCapabilities"])("retains %s without converting service versions into dataset releases", async resourceType => {
  const raw = { resourceType, ...(resourceType === "CapabilityStatement" ? { fhirVersion: "5.0.0" } : {}), version: "2.6", codeSystem: [{ uri: WHO_SYSTEMS[1], version: [{ code: "2025-01" }] }] }; setup(raw);
  expect(await api({ method: "GET", path: "/fhir/metadata", params: resourceType === "TerminologyCapabilities" ? { mode: "terminology" } : {} })).toMatchObject({ data: { ...raw, _who_fhir: { requested: { release: null } } } });
});
it("rejects malformed validation results", async () => {
  setup({ resourceType: "Parameters", parameter: [{ name: "result", valueString: "false" }] });
  await expect(api({ method: "GET", path: "/fhir/CodeSystem/$validate-code", params: { url: WHO_SYSTEMS[1], code: "1A00", version: "2025-01", language: "en" } })).rejects.toMatchObject({ status: 502 });
});
it.each([{ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported" }] }, { resourceType: "CodeSystem", version: "2025-01" }, { unrelated: true }])("does not turn FHIR error or wrong-resource bodies into lookup success %#", async raw => {
  setup(raw); await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 502 });
});
it("does not switch to offline MMS on upstream unavailability", async () => {
  const fetcher = setup({ resourceType: "OperationOutcome" }, 503);
  await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params })).rejects.toMatchObject({ status: 503 }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([env.ICD11_CLIENT_SECRET, "fixture-who-bearer-token"])("withholds authentication echoes %#", async secret => {
  setup({ ...lookup(), diagnostic: secret });
  await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params })).rejects.toThrow(/withheld/);
});
it("bounds response bytes without partial success", async () => {
  setup({ ...lookup(), extra: "α".repeat(1_100_000) });
  await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params })).rejects.toThrow(/2097152 bytes/);
});
it("preserves native release/language metadata via the existing authenticated root", async () => {
  const raw = { allreleases: ["2025-01", "2026-01"], availableLanguages: ["en", "de"], prereleaseLanguages: ["de"] }; const fetcher = setup(raw);
  const result = await api({ method: "GET", path: "/release/11/2026-01/icf" });
  const { _mcp, ...native } = result.data as Record<string, unknown>;
  expect(native).toEqual(raw);
  expect(result).toMatchObject({ status: 200, completeness: { complete: false }, upstreamTotal: null, data: { _mcp: { provenance: { raw_json: JSON.stringify(raw) } } } });
  expect(fetcher.mock.calls[1][0]).toBe("https://id.who.int/icd/release/11/2026-01/icf");
});
it("requires credentials for FHIR before any networking", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const keyless = (await import("./api-adapter")).createIcd11ApiFetch({});
  await expect(keyless({ method: "GET", path: "/fhir/CodeSystem" })).rejects.toThrow(/ICD11_CLIENT_ID/); expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { ...params, version: undefined }, { ...params, displayLanguage: undefined }, { ...params, system: "http://snomed.info/sct" },
  { ...params, version: "latest" }, { ...params, version: 2025 }, { ...params, displayLanguage: ["en", "es"] },
  { ...params, sytem: WHO_SYSTEMS[1] }, { ...params, system: WHO_SYSTEMS[0] },
  { ...params, code: "http://id.who.int/icd/release/11/2026-01/mms/257068234" },
  { ...params, code: "http://id.who.int/icd/release/11/icf/257068234" },
])("rejects missing/ambiguous/mixed-system inputs before networking %#", async input => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(api({ method: "GET", path: "/fhir/CodeSystem/$lookup", params: input })).rejects.toMatchObject({ status: 400 }); expect(fetcher).not.toHaveBeenCalled();
});
it("accepts Foundation entity URIs with an explicit system and release", () => {
  expect(fhirInput({ method: "GET", path: "/fhir/CodeSystem/$lookup", params: { ...params, system: WHO_SYSTEMS[0], code: "http://id.who.int/icd/entity/257068234" } }).system).toBe(WHO_SYSTEMS[0]);
});
it.each([
  { method: "POST", path: "/fhir/CodeSystem", body: {} },
  { method: "GET", path: "/fhir/CodeSystem?version=2025-01&version=2026-01" },
  { method: "GET", path: "/fhir/CodeSystem?version=2025-01", params: { version: "2026-01" } },
  { method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale.replace("2025-01/", ""), displayLanguage: "en" } },
  { method: "GET", path: "/fhir/ValueSet/$expand", params: { url: scale, displayLanguage: "en", count: 501 } },
  { method: "GET", path: "/fhir/ValueSet/$validate-code", params: { url: scale, system: WHO_SYSTEMS[2], code: "x", language: "en" } },
])("rejects unsupported method or ambiguous scope %#", input => { expect(() => fhirInput(input)).toThrow(); });
