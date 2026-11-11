import { fail, object } from "./response";

/** FHIR R5 permits hierarchical expansions to ignore paging; expose that distinction. */
export function expansionContext(resource: Record<string, unknown>, params: Record<string, string | number>) {
  const expansion = object(resource.expansion);
  if (expansion.contains !== undefined && !Array.isArray(expansion.contains)) fail("WHO FHIR expansion.contains must be an array", 502);
  const contains = (expansion.contains ?? []) as unknown[];
  const hierarchical = contains.some(item => Array.isArray(object(item).contains));
  const requested = params.offset !== undefined || params.count !== undefined;
  const offset = expansion.offset ?? 0;
  if (requested && !hierarchical && (offset !== (params.offset ?? 0) || (params.count !== undefined && contains.length > Number(params.count)))) fail("WHO FHIR did not honor the requested flat expansion page", 409);
  return {
    kind: hierarchical ? "hierarchical" : "flat",
    requested_count: params.count ?? null,
    requested_offset: params.offset ?? null,
    returned_offset: expansion.offset ?? null,
    returned_total: expansion.total ?? null,
    paging_honored: requested ? !hierarchical : null,
    note: hierarchical ? "FHIR hierarchical expansions are unpaged; the provider may ignore count/offset. Full returned hierarchy is retained." : "Only the returned page is represented; totals and timestamps remain provider evidence.",
  };
}
