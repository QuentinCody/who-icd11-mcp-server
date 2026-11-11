import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { fhirInput } from "./fhir-input";
import { expansionContext } from "./fhir-expansion";
import { type Icd11Env, icd11FhirFetch } from "./http";
import { fail, object } from "./response";
import { readIcd11Json } from "./read";
import { WHO_PAGE_COMPLETENESS } from "./completeness";
function parameterStrings(resource: Record<string, unknown>, name: string): string[] {
  if (!Array.isArray(resource.parameter)) return [];
  return resource.parameter.flatMap(value => {
    const item = object(value);
    const text = item.valueString ?? item.valueCode ?? item.valueUri;
    return item.name === name && typeof text === "string" ? [text] : [];
  });
}
export function createFhirFetch(env: Icd11Env): ApiFetchFn {
  return async request => {
    const input = fhirInput(request);
    if (new TextEncoder().encode(input.target).byteLength > 32_000) fail("WHO FHIR request URL exceeds byte limit");
    const signal = AbortSignal.timeout(45_000);
    const response = await icd11FhirFetch(input.target, env, { headers: { Accept: "application/fhir+json", "Accept-Language": input.language }, signal });
    const source = await readIcd11Json(response, env, `https://id.who.int${input.target}`, { method: "GET", path: input.path, params: input.params, language: input.language }, signal);
    try {
    return buildFhirResult(source, input, response);
    } catch (error) {
      const reason = error as Error & { status?: number; data?: unknown };
      fail(reason.message, reason.status ?? 502, { ...(source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data : { resource: source.data }),
        _mcp: { provenance: source.provenance, completeness: WHO_PAGE_COMPLETENESS }, validation_error: reason.data ?? null });
    }
  };
}

function buildFhirResult(source: { status: number; data: unknown; provenance: { source_url: string; request: unknown; retrieved_at: string; response_sha256: string; response_bytes: number; raw_json: string; redacted: boolean; }; }, input: { path: string; params: Record<string, string | number>; language: string; system: string | number; release: string | number; target: string; }, response: Response) {
  const { search, resource, expand, reported, lookup } = validateFhirResource(source, input);
  if (search) {
    if (resource.entry !== undefined && !Array.isArray(resource.entry)) fail("WHO FHIR Bundle entry is malformed", 502);
    for (const raw of (resource.entry ?? []) as unknown[]) {
      const entry = object(object(raw).resource);
      if (entry.resourceType !== input.path.slice("/fhir/".length)) fail("WHO FHIR search returned the wrong entry type", 502);
      if (input.params.url && entry.url !== input.params.url) fail("WHO FHIR ignored the requested canonical URL", 409);
      if (input.params.version && entry.version !== input.params.version) fail("WHO FHIR did not establish the requested resource version", 409);
    }
  }
  if (expand && resource.url !== input.params.url) fail("WHO FHIR expansion did not establish the requested release-qualified ValueSet", 409);
  return {
    status: response.status, completeness: WHO_PAGE_COMPLETENESS, upstreamTotal: null, data: {
      ...resource,
      _mcp: { provenance: source.provenance, completeness: WHO_PAGE_COMPLETENESS }, _who_fhir: {
        source_url: `https://id.who.int${input.target}`, retrieved_at: new Date().toISOString(), prerelease: true, documented_fhir_version: "5.0.0",
        requested: { system: input.system, release: input.release, language: input.language, query: input.params },
        ...(expand ? { expansion: expansionContext(resource, input.params) } : {}),
        reported_parameter_versions: reported, resource_version: resource.version ?? null, resource_language: resource.language ?? null,
        lookup_release_verified: lookup ? true : null,
        version_note: "Requests, resource versions and code-system versions are distinct. Empty searches do not establish availability. Validation may omit version evidence. Requested language does not prove translation completeness; preserve designations and expansion parameters.",
      }
    }
  };
}

function validateFhirResource(source: { status: number; data: unknown; provenance: { source_url: string; request: unknown; retrieved_at: string; response_sha256: string; response_bytes: number; raw_json: string; redacted: boolean; }; }, input: { path: string; params: Record<string, string | number>; language: string; system: string | number; release: string | number; target: string; }) {
  const resource = object(source.data);
  if (resource.resourceType === "OperationOutcome") fail("WHO FHIR returned an OperationOutcome", 502, resource);
  const lookup = input.path.endsWith("/$lookup");
  const validation = input.path.endsWith("/$validate-code");
  const expand = input.path.endsWith("/$expand");
  const search = input.path === "/fhir/CodeSystem" || input.path === "/fhir/ValueSet";
  const metadata = input.path === "/fhir/metadata";
  const expected = lookup || validation ? ["Parameters"] : expand ? ["ValueSet"] : search ? ["Bundle"] : metadata ? ["CapabilityStatement", "TerminologyCapabilities"] : ["CodeSystem"];
  if (!expected.includes(String(resource.resourceType))) fail("WHO FHIR returned the wrong resource type", 502);
  if (metadata && resource.fhirVersion !== undefined && resource.fhirVersion !== "5.0.0") fail("WHO FHIR capability statement did not report the documented R5 version", 409);
  const reported = [...new Set(parameterStrings(resource, "version"))];
  if (lookup && (reported.length !== 1 || reported[0] !== input.release)) fail("WHO FHIR did not establish the requested lookup release", 409, { requested_release: input.release, reported_versions: reported });
  if (validation) {
    const results = Array.isArray(resource.parameter) ? resource.parameter.map(object).filter(item => item.name === "result") : [];
    if (results.length !== 1 || typeof results[0].valueBoolean !== "boolean") fail("WHO FHIR validation lacks an unambiguous boolean result", 502);
    if (input.path.startsWith("/fhir/CodeSystem/") && reported.some(version => version !== input.release)) fail("WHO FHIR validation returned a different code-system release", 409);
  }
  return { search, resource, expand, reported, lookup };
}
