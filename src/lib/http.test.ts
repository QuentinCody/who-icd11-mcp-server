import { afterEach, beforeEach, expect, it, vi } from "vitest";
let http: typeof import("./http");
const env = { ICD11_CLIENT_ID: "fixture-http-client", ICD11_CLIENT_SECRET: "fixture-http-secret" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const token = (value = "fixture-http-token") => json({ access_token: value, expires_in: 3600 });
beforeEach(async () => { vi.resetModules(); http = await import("./http"); });
afterEach(() => vi.unstubAllGlobals());
it("reuses a matching credential token across native REST and FHIR", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetcher);
  await http.icd11Fetch("/entity", env); await http.icd11FhirFetch("/fhir/CodeSystem", env);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(Object.fromEntries(new URLSearchParams(fetcher.mock.calls[0][1].body))).toEqual({ client_id: env.ICD11_CLIENT_ID, client_secret: env.ICD11_CLIENT_SECRET, scope: "icdapi_access", grant_type: "client_credentials" });
  expect(fetcher.mock.calls[2][0]).toBe("https://id.who.int/fhir/CodeSystem");
  expect(fetcher.mock.calls[2][1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
});
it("does not reuse tokens after credential rotation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({})).mockResolvedValueOnce(token("rotated-token")).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetcher);
  await http.icd11Fetch("/entity", env); await http.icd11FhirFetch("/fhir/CodeSystem", { ...env, ICD11_CLIENT_SECRET: "rotated-secret" });
  expect(fetcher).toHaveBeenCalledTimes(4); expect(fetcher.mock.calls[3][1].headers.Authorization).toBe("Bearer rotated-token");
});
it("refreshes once after 401 and retains the path, language and total deadline", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(token("fresh-token")).mockResolvedValueOnce(json({}, 401)); vi.stubGlobal("fetch", fetcher);
  const signal = AbortSignal.timeout(45000);
  expect((await http.icd11FhirFetch("/fhir/metadata", env, { signal, headers: { "Accept-Language": "es" } })).status).toBe(401);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[3][1]).toMatchObject({ signal, headers: { Authorization: "Bearer fresh-token", "Accept-Language": "es" } });
});
it.each([{ access_token: "x" }, { access_token: "bad token", expires_in: 3600 }, { access_token: "x", expires_in: -1 }])("rejects invalid OAuth responses without leaking their content %#", async raw => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(raw)); vi.stubGlobal("fetch", fetcher);
  await expect(http.icd11FhirFetch("/fhir/metadata", env)).rejects.toMatchObject({ status: 502 }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("withholds token-endpoint error bodies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ echo: env.ICD11_CLIENT_SECRET }, 400)));
  await expect(http.icd11FhirFetch("/fhir/metadata", env)).rejects.toMatchObject({ status: 400, message: "ICD-11 token fetch failed (400); check Worker credentials" });
});
