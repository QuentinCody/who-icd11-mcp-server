import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { fail } from "./response";
export const WHO_SYSTEMS = ["http://id.who.int/icd/entity", "http://id.who.int/icd/release/11/mms", "http://id.who.int/icd/release/11/icf"];
const routes: Record<string, string[]> = {
  "/fhir/metadata": ["mode", "language"],
  "/fhir/CodeSystem": ["url", "version", "name", "name:contains", "language"],
  "/fhir/CodeSystem/$lookup": ["system", "code", "version", "displayLanguage"],
  "/fhir/CodeSystem/$validate-code": ["url", "code", "version", "display", "language"],
  "/fhir/ValueSet": ["url", "language"],
  "/fhir/ValueSet/$expand": ["url", "displayLanguage", "filter", "count", "offset"],
  "/fhir/ValueSet/$validate-code": ["url", "system", "code", "display", "language"],
};
export function valueSetIdentity(url: string) {
  const match = /^http:\/\/id\.who\.int\/icd\/release\/11\/(\d{4}-(?:0[1-9]|1[0-2]))\/(mms|icf)\/\d+\/postcoordinationScale\/[A-Za-z][A-Za-z0-9]*$/.exec(url);
  if (!match) fail("Use a release-qualified WHO postcoordination ValueSet canonical from lookup, retaining release, linearization, entity and axis");
  return { release: match[1], system: `http://id.who.int/icd/release/11/${match[2]}` };
}
export function fhirInput(request: Parameters<ApiFetchFn>[0]) {
  const { path, params } = parseFhirParameters(request);
  const { identity, system } = validateFhirIdentity(path, params);
  const language = String(params.displayLanguage ?? params.language ?? "en");
  if (!/^[a-z]{2}$/.test(language)) fail("Use an explicit ISO 639-1 language; discover provider-supported languages first");
  for (const [key, max, minimum] of [["count", 500, 1], ["offset", 10000, 0]] as const) if (params[key] !== undefined) {
    const value = Number(params[key]);
    if (!Number.isInteger(value) || value < minimum || value > max) fail(`${key} must be an integer from ${minimum} to ${max}`);
    params[key] = value;
  }
  const native = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (key !== "language") native.set(key, String(value));
  return { path, params, language, system: system ?? null, release: identity?.release ?? params.version ?? null, target: `${path}${native.size ? `?${native}` : ""}` };
}

function parseFhirParameters(request: Parameters<ApiFetchFn>[0]) {
  if (request.method.toUpperCase() !== "GET" || request.body !== undefined) fail("WHO FHIR catalog supports GET reads without a body", 405);
  if (request.path.includes("#") || request.path.includes("\\") || request.path.includes("..")) fail("Invalid WHO FHIR path");
  const [path, query = ""] = request.path.split("?");
  if (request.path.split("?").length > 2) fail("Invalid WHO FHIR query");
  const direct = /^\/fhir\/CodeSystem\/[A-Za-z0-9.-]+$/.test(path);
  const allowed = routes[path] ?? (direct ? ["language"] : undefined);
  if (!allowed) fail("Unsupported WHO FHIR read route", 404);
  const params: Record<string, string | number> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (key in params) fail(`Repeated WHO FHIR parameter: ${key}`);
    params[key] = value;
  }
  for (const [key, value] of Object.entries(request.params ?? {})) {
    if (value === undefined) continue;
    if (key in params && String(params[key]) !== String(value)) fail(`Conflicting WHO FHIR parameter: ${key}`);
    if (typeof value !== "string" && typeof value !== "number") fail(`Invalid WHO FHIR parameter: ${key}`);
    params[key] = value;
  }
  validateFhirParameterValues(params, allowed);
  return { path, params };
}

function validateFhirParameterValues(params: Record<string, string | number>, allowed: string[]) {
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.includes(key)) fail(`Unsupported WHO FHIR parameter: ${key}`);
    if (String(value).length > 2000 || !String(value).trim()) fail(`Invalid WHO FHIR parameter: ${key}`);
    if (key !== "count" && key !== "offset" && typeof value !== "string") fail(`${key} must be a string`);
  }
}

function validateFhirIdentity(path: string, params: Record<string, string | number>) {
  const operation = path.includes("/$");
  const isValueSet = path.startsWith("/fhir/ValueSet");
  const required = operation ? isValueSet ? path.endsWith("/$expand") ? ["url", "displayLanguage"] : ["url", "system", "code", "language"]
    : path.endsWith("/$lookup") ? ["system", "code", "version", "displayLanguage"] : ["url", "code", "version", "language"] : [];
  for (const key of required) if (params[key] === undefined) fail(`${path} requires explicit ${key}`);
  if (params.version !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(params.version))) fail("version must be an explicit WHO release such as 2025-01; discover availability first");
  if (params.system !== undefined && !WHO_SYSTEMS.includes(String(params.system))) fail("Unsupported WHO CodeSystem canonical");
  if (!isValueSet && params.url !== undefined && !WHO_SYSTEMS.includes(String(params.url))) fail("Unsupported WHO CodeSystem canonical");
  const identity = isValueSet && params.url !== undefined ? valueSetIdentity(String(params.url)) : undefined;
  if (identity && params.system !== undefined && params.system !== identity.system) fail("ValueSet and code system linearizations disagree");
  const system = identity?.system ?? params.system ?? params.url;
  const code = params.code;
  if (system === WHO_SYSTEMS[0] && code !== undefined && !/^http:\/\/id\.who\.int\/icd\/entity\/\d+$/.test(String(code))) fail("Foundation codes are full entity URIs, not MMS codes");
  validateCodeUri(code, system, params, identity);
  return { identity, system };
}

function validateCodeUri(code: string | number, system: string | number, params: Record<string, string | number>, identity: { release: string; system: string; } | undefined) {
  if (typeof code === "string" && code.startsWith("http") && system !== WHO_SYSTEMS[0]) {
    const match = /^http:\/\/id\.who\.int\/icd\/release\/11\/(?:(\d{4}-\d{2})\/)?(mms|icf)\/\d+$/.exec(code);
    if (!match || `http://id.who.int/icd/release/11/${match[2]}` !== system || (match[1] && match[1] !== (params.version ?? identity?.release))) fail("Code URI disagrees with the requested release or linearization");
  }
}
