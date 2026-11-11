import { expect, it } from "vitest";
import { icd11Response } from "./tool-result";

it("chooses the real credential tier when citing errors and schema responses", async () => {
  for (const credentialed of [true, false]) {
    const env = credentialed ? { ICD11_CLIENT_ID: "fixture", ICD11_CLIENT_SECRET: "fixture" } : {};
    const result = await icd11Response(async () => { throw new Error("No storage"); }, env, "icd11_get_schema", {});
    expect(result).toMatchObject({ isError: true, structuredContent: { _meta: { citation: { source: { id: credentialed ? "icd11-credentialed" : "icd11-keyless" } } } } });
    expect(JSON.stringify(result)).toContain("clinicaltables.nlm.nih.gov");
  }
});

function storage() {
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") stored.push((await request.json() as { data: unknown }).data);
    return Response.json({ success: true, tables_created: ["payloads"], total_rows: 1, input_rows: 1, schema: { tables: {} } });
  } }) };
  return { stored, env: { ICD11_DATA_DO: namespace } };
}

it("stages the full Unicode envelope while preserving failure and citations", async () => {
  const original = { content: [{ type: "text" as const, text: "α😀".repeat(6000) }], structuredContent: { success: false, data: { article_id: "123", notes: "native evidence" } }, isError: true };
  const { stored, env } = storage();
  const result = await icd11Response(async () => original, env, "mcp_icd11_execute", {}, { code: "fixture" });
  expect(result).toMatchObject({ isError: true, structuredContent: { success: false, staged: true, _staging: { evidence_table: "payloads" }, _meta: { citation: { source: { id: "icd11-keyless" }, result_scope: "staged:full_result" } } } });
  expect(stored.map(value => typeof value === "string" ? JSON.parse(value) : value)).toEqual(expect.arrayContaining([expect.objectContaining({ content: original.content, isError: true, structuredContent: expect.objectContaining({ data: original.structuredContent.data }) })]));
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30720);
});

it("returns a bounded cited error if staging storage is unavailable", async () => {
  const result = await icd11Response(async () => ({ content: [{ type: "text", text: "α".repeat(20000) }], structuredContent: { success: true } }), {}, "icd11_execute", {});
  expect(result).toMatchObject({ content: expect.any(Array), isError: true, structuredContent: { success: false, error: { code: "RESPONSE_ERROR" }, _meta: { citation: { result_hash: expect.any(String) } } } });
});

it("reserves bytes for SDK metadata before the staging boundary", async () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const raw = { content: [{ type: "text" as const, text: "Result" }], structuredContent: { data: "" } };
  const baseline = await icd11Response(async () => raw, {}, "icd11_query_data", {});
  const original = { ...raw, structuredContent: { data: "x".repeat(30720 - size(baseline) - 512) } };
  const result = await icd11Response(async () => original, storage().env, "icd11_query_data", {});
  expect(result.structuredContent).toMatchObject({ staged: true, _meta: { citation: { result_scope: "staged:full_result" } } });
  const wire = { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "icd11", version: "1" } } };
  expect(size(wire)).toBeLessThan(30720);
});

it("preserves upstream errors and marks partial executions as errors", async () => {
  const evidence = { native_error: "Path or Query Parameter error", response_evidence: { http_status: 400 } };
  const thrown = await icd11Response(async () => { throw Object.assign(new Error("Native request failed"), { status: 400, data: evidence }); }, {}, "icd11_execute", {});
  expect(thrown).toMatchObject({ isError: true, structuredContent: { success: false, data: evidence, error: { status: 400 } } });
  for (const structuredContent of [{ success: true, disposition: "partial", data: { article_id: "123" } }, { data: { __api_error: true, status: 410 } }]) {
    const result = await icd11Response(async () => ({ content: [], structuredContent }), {}, "icd11_execute", {});
    expect(result).toMatchObject({ isError: true, structuredContent: { success: false } });
  }
});
