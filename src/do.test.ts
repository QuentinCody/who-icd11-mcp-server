/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { Icd11DataDO } from "./do";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
async function store(data: unknown) {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  let ready: Promise<unknown> = Promise.resolve();
  const exec = (sql: string, ...args: SQLInputValue[]) => {
    const rows = database.prepare(sql).all(...args);
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  const ctx = { blockConcurrencyWhile: (run: () => Promise<unknown>) => { ready = run(); return ready; },
    storage: { sql: { exec }, transactionSync: (run: () => unknown) => {
      database.exec("BEGIN"); try { const result = run(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } } };
  // This test fixture implements only the Durable Object storage interfaces used here.
  const instance = new Icd11DataDO(ctx as unknown as ConstructorParameters<typeof Icd11DataDO>[0], {} as ConstructorParameters<typeof Icd11DataDO>[1]);
  await ready;
  const result = await instance.fetch(new Request("https://fixture/process", { method: "POST", body: JSON.stringify({ data }) }));
  expect(await result.json()).toMatchObject({ success: true });
  return database;
}

it("retains repeated FHIR parameters, nested parts, native collisions and source order", async () => {
  const resource = { resourceType: "Parameters", parameter: [{ name: "version", valueString: "2025-01" }, { name: "property", part: [{ name: "code", valueCode: "001" }, { name: "value", valueString: "α😀" }] }, { name: "property", part: [] }], _mcp: { native: true }, _who_fhir: null };
  const db = await store({ ...resource, _mcp: { provenance: { raw_json: JSON.stringify(resource) } } });
  const rows = db.prepare("SELECT path, parent_path, sibling_index, native_json FROM fhir_parameters ORDER BY node_index").all();
  expect(rows.map(row => row.path)).toEqual(["/parameter/0", "/parameter/1", "/parameter/1/part/0", "/parameter/1/part/1", "/parameter/2"]);
  expect(rows.map(row => row.sibling_index)).toEqual([0, 1, 0, 1, 2]);
  expect(rows[2].parent_path).toBe("/parameter/1");
  expect(JSON.parse(String(rows[2].native_json))).toEqual({ name: "code", valueCode: "001" });
  expect(JSON.parse(String(db.prepare("SELECT native_json FROM fhir_response").get()?.native_json))).toEqual(resource);
});
it("retains hierarchical expansion parents, repeated codes, versions, parameters and absent values", async () => {
  const resource = { resourceType: "ValueSet", version: "scale-v7", expansion: { total: 10, offset: 5, timestamp: "fixture", parameter: [{ name: "version", valueString: "2025-01" }], contains: [{ abstract: true, contains: [{ code: "001", system: "mms", version: "2025-01" }, { code: "001", system: "icf", version: "2024-01", display: null }] }, { code: "001", contains: [] }] } };
  const db = await store({ content: [], structuredContent: { data: resource } });
  const rows = db.prepare("SELECT * FROM fhir_contains ORDER BY node_index").all();
  expect(rows.map(row => row.path)).toEqual(["/expansion/contains/0", "/expansion/contains/0/contains/0", "/expansion/contains/0/contains/1", "/expansion/contains/1"]);
  expect(rows[1]).toMatchObject({ parent_path: "/expansion/contains/0", code: "001", system: "mms", version: "2025-01" });
  expect(JSON.parse(String(db.prepare("SELECT native_json FROM fhir_response").get()?.native_json))).toEqual(resource);
});
it("preserves empty bundles, links, entry order and nonresource controls", async () => {
  const resource = { resourceType: "Bundle", total: 2, link: [{ relation: "next", url: "fixture" }], entry: [{ resource: { id: "001" } }, { resource: { id: "001" }, extra: null }] };
  const db = await store(resource);
  expect(db.prepare("SELECT native_json FROM fhir_entries ORDER BY entry_index").all().map(row => JSON.parse(String(row.native_json)))).toEqual(resource.entry);
  const empty = await store({ ...resource, entry: [] });
  expect(JSON.parse(String(empty.prepare("SELECT native_json FROM fhir_response").get()?.native_json))).toEqual({ ...resource, entry: [] });
});
it("keeps keyless rows and their existing table names", async () => {
  const data = { tier: "keyless_offline", results: [{ code: "001", title: "Synthetic", parent_entity_id: "0007" }], provenance: { source: "icdcdn.who.int" } };
  const db = await store(data);
  expect(db.prepare("SELECT code,title,parent_entity_id FROM mms_rows").all()).toEqual(data.results);
});
it("keeps serialized evidence on payloads and restaged SQL rows in their original order", async () => {
  const data = { resourceType: "OperationOutcome", issue: [{ diagnostics: "α".repeat(100) }] };
  const db = await store(JSON.stringify(data));
  const stored = JSON.parse(String(db.prepare("SELECT root_json FROM payloads WHERE id=1").get()?.root_json));
  expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual(data);
  const rows = [{ _rowid: 7, code: "001" }, { _rowid: 7, code: null }];
  const queries = await store({ sql: "SELECT * FROM fixture", rows });
  expect(queries.prepare("SELECT native_json FROM query_rows ORDER BY row_index").all().map(row => JSON.parse(String(row.native_json)))).toEqual(rows);
});
