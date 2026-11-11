export function fail(message: string, status = 400, data?: unknown): never {
  throw Object.assign(new Error(message), { status, ...(data === undefined ? {} : { data }) });
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("WHO returned an invalid object", 502);
  return value as Record<string, unknown>;
}
