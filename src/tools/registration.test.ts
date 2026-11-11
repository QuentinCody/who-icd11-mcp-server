import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { registerCodeMode } from "./code-mode";
import { registerQueryData } from "./query-data";
import { registerGetSchema } from "./get-schema";
import { icd11Catalog, buildIcd11Catalog } from "../spec/catalog";
import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
let api: ApiFetchFn;
const system = "http://id.who.int/icd/release/11/mms";
const params = { system, code: "1A00", version: "2025-01", displayLanguage: "en" };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/fhir+json" } });
function setup(raw: unknown) { vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ access_token: "registration-fixture-token", expires_in: 3600 })).mockResolvedValueOnce(json(raw))); }
beforeEach(async () => { vi.resetModules(); api = (await import("../lib/api-adapter")).createIcd11ApiFetch({ ICD11_CLIENT_ID: "registration-fixture-client", ICD11_CLIENT_SECRET: "registration-fixture-secret" }); });
afterEach(() => vi.unstubAllGlobals());
it("registers both aliases and discovers pre-release FHIR with both-fields contracts", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  for (const name of ["icd11_search", "icd11_execute", "icd11_query_data", "icd11_get_schema"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  const result = await tools.mcp_icd11_search.handler({ query: "WHO FHIR lookup in Spanish with an explicit release", category: "workflows", max_results: 5 }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
  expect(JSON.stringify(result)).toContain("displayLanguage");
  expect(await tools.mcp_icd11_query_data.handler({ data_access_id: "icd11_fixture", sql: "SELECT 1" }, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: expect.any(Object) });
  expect(icd11Catalog.endpointCount).toBe(icd11Catalog.endpoints.length);
  expect(buildIcd11Catalog(false).notes).toContain("/fhir/*");
});
it("stages complete FHIR properties/designations and release/language context", async () => {
  const raw = { resourceType: "Parameters", parameter: [{ name: "version", valueString: "2025-01" }, { name: "property", part: [{ name: "code", valueCode: "definition" }, { name: "value", valueString: "α".repeat(17_000) }] }, { name: "designation", part: [{ name: "language", valueCode: "en" }, { name: "value", valueString: "Cholera" }] }] };
  setup(raw);
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as { data: unknown }).data);
      return json({ success: true, tables_created: ["parameter"], total_rows: 3, input_rows: 3, table_row_counts: { parameter: 3 } });
    }
    return json({ success: true, schema: { tables: { parameter: { columns: [{ name: "name" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  const proxy = createApiProxyTool({ apiFetch: api, catalog: icd11Catalog, doNamespace: namespace, stagingPrefix: "icd11", maxInlineBytes: 30 * 1024 });
  const result = await proxy.handler({ method: "GET", path: "/fhir/CodeSystem/$lookup", params }, { sql: () => [] });
  expect(result).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
  expect(JSON.parse(stored[0] as string)).toMatchObject({ ...raw, _who_fhir: { prerelease: true, requested: { system, release: "2025-01", language: "en" }, lookup_release_verified: true } });
  expect(stored[1]).toMatchObject(raw);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30_000);
});
it.each([{ __api_error: true, status: 409 }, { __staged: true, data_access_id: "icd11_fixture" }, { __stage_error: true, message: "staging unavailable" }])("recipes preserve error and staging handles %#", async handle => {
  for (const workflow of icd11Catalog.workflows!) {
    const run = new Function("api", `return (async () => { ${workflow.code} })()`);
    expect(await run({ get: vi.fn().mockResolvedValue(handle) })).toEqual(handle);
  }
});
it("release mismatch survives canonical proxy handling", async () => {
  setup({ resourceType: "Parameters", parameter: [{ name: "version", valueString: "2026-01" }] });
  const proxy = createApiProxyTool({ apiFetch: api, catalog: icd11Catalog, stagingPrefix: "icd11", maxInlineBytes: 30 * 1024 });
  expect(await proxy.handler({ method: "GET", path: "/fhir/CodeSystem/$lookup", params }, { sql: () => [] })).toMatchObject({ __api_error: true, status: 409, incomplete: true });
});
