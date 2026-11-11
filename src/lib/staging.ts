const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Recover the provider's resource even when it used our reserved metadata names. */
export function nativeIcd11(value: unknown): unknown {
  const data = record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent ? value.structuredContent.data : value;
  const provenance = record(data) && record(data._mcp) && record(data._mcp.provenance) ? data._mcp.provenance : {};
  if (typeof provenance.raw_json === "string") {
    try { return JSON.parse(provenance.raw_json.replace(/^\uFEFF/, "")); } catch { /* The base payload preserves invalid JSON evidence. */ }
  }
  return data;
}

/** Paths and sibling order preserve repeated names and nested FHIR parts/terms. */
function orderedTree(items: unknown[], root: string, child: string) {
  const stack = items.map((value, index) => ({ value, path: `${root}/${index}`, parent_path: root, sibling_index: index })).reverse();
  const rows: Record<string, unknown>[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    const item = record(node.value) ? node.value : {};
    rows.push({ node_index: rows.length, path: node.path, parent_path: node.parent_path, sibling_index: node.sibling_index,
      name: typeof item.name === "string" ? item.name : null, code: typeof item.code === "string" ? item.code : null,
      system: typeof item.system === "string" ? item.system : null, version: typeof item.version === "string" ? item.version : null,
      native_json: JSON.stringify(node.value) });
    const children = item[child];
    if (Array.isArray(children)) for (let index = children.length - 1; index >= 0; index--) stack.push({ value: children[index], path: `${node.path}/${child}/${index}`, parent_path: node.path, sibling_index: index });
  }
  return rows;
}

export function icd11Tables(data: unknown): unknown {
  if (!record(data)) return data;
  if (typeof data.sql === "string" && Array.isArray(data.rows)) return { query_rows: data.rows.map((row, row_index) => ({ row_index, native_json: JSON.stringify(row) })) };
  if (typeof data.resourceType !== "string") return data;
  const tables: Record<string, unknown> = { fhir_response: [{ response_index: 0, resource_type: data.resourceType, native_json: JSON.stringify(data) }] };
  if (Array.isArray(data.parameter)) tables.fhir_parameters = orderedTree(data.parameter, "/parameter", "part");
  if (Array.isArray(data.entry)) tables.fhir_entries = data.entry.map((entry, entry_index) => ({ entry_index, native_json: JSON.stringify(entry) }));
  if (record(data.expansion) && Array.isArray(data.expansion.contains)) tables.fhir_contains = orderedTree(data.expansion.contains, "/expansion/contains", "contains");
  return tables;
}
