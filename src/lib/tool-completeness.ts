import { type Completeness, mergeCompleteness } from "@bio-mcp/shared";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function icd11Completeness(value: unknown): Completeness | undefined {
  const pending = [value]; const seen = new Set<unknown>(); let found: Completeness | undefined;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (record(current)) for (const key of ["_mcp", "_staging"]) {
      const context = current[key];
      if (record(context) && record(context.completeness) && context.completeness.complete === false) found = mergeCompleteness(found, context.completeness as unknown as Completeness);
    }
    for (const child of Object.values(current)) pending.push(child);
  }
  return found;
}
