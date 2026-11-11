import { type Icd11Env, icd11Fetch } from "./http";
import { readIcd11Json } from "./read";
import { fail } from "./response";
import { WHO_PAGE_COMPLETENESS } from "./completeness";

/** Existing native REST surface; kept separate from FHIR and offline datasets. */
export async function handleLive(path: string, params: Record<string, unknown>, env: Icd11Env) {
  let target = path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" || typeof value === "number" && !Number.isFinite(value))) fail("Invalid WHO API parameter");
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  if (qs.size) target = `${target}${target.includes("?") ? "&" : "?"}${qs}`;
  if (new TextEncoder().encode(target).byteLength > 32_000) fail("WHO API request URL exceeds byte limit");
  const signal = AbortSignal.timeout(45_000);
  const response = await icd11Fetch(target, env, { signal });
  const source = await readIcd11Json(response, env, `https://id.who.int/icd${target}`, { method: "GET", path, params, language: "en", api_version: "v2" }, signal);
  const data = source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data : { data: source.data };
  return { status: source.status, completeness: WHO_PAGE_COMPLETENESS, upstreamTotal: null,
    data: { ...data, _mcp: { provenance: source.provenance, completeness: WHO_PAGE_COMPLETENESS } } };
}
