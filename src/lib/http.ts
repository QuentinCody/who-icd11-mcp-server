/**
 * WHO ICD-11 API HTTP client with OAuth 2.0 client credentials flow.
 *
 * Token endpoint: https://icdaccessmanagement.who.int/connect/token
 * API base: https://id.who.int/icd
 */

import { fail, object, readText } from "./response";
import { boundedFetch } from "./deadline";

const TOKEN_URL = "https://icdaccessmanagement.who.int/connect/token";
const ICD11_BASE = "https://id.who.int/icd";

export interface Icd11Env {
    ICD11_CLIENT_ID?: string;
    ICD11_CLIENT_SECRET?: string;
}

// Module-level token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let cachedClientId: string | undefined;
let cachedClientSecret: string | undefined;
const responseTokens = new WeakMap<Response, string[]>();

/**
 * Fetch an OAuth 2.0 access token using client credentials grant.
 * Caches the token until 60 seconds before expiry.
 */
async function getAccessToken(env: Icd11Env, signal: AbortSignal): Promise<string> {
    // Without this guard WHO answers an empty client_id with a bare
    // 400 {"error":"invalid_client"}, which reads like a rejected key rather
    // than a Worker that was never given one.
    if (!env.ICD11_CLIENT_ID || !env.ICD11_CLIENT_SECRET) {
        throw new Error(
            "ICD11_CLIENT_ID / ICD11_CLIENT_SECRET are not set on this Worker, so the gated " +
                "WHO ICD-11 API cannot be called. Register free at " +
                "https://icd.who.int/icdapi/Account/Register and set both with 'wrangler secret put'.",
        );
    }

    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt && cachedClientId === env.ICD11_CLIENT_ID && cachedClientSecret === env.ICD11_CLIENT_SECRET) {
        return cachedToken;
    }

    const body = new URLSearchParams({
        client_id: env.ICD11_CLIENT_ID,
        client_secret: env.ICD11_CLIENT_SECRET,
        scope: "icdapi_access",
        grant_type: "client_credentials",
    });

    const response = await boundedFetch(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal,
        redirect: "manual",
    });

    if (response.status !== 200 || response.headers.has("content-range")) {
        void response.body?.cancel().catch(() => undefined);
        fail(`ICD-11 token fetch failed (${response.status}); check Worker credentials`, response.status === 200 ? 502 : response.status);
    }

    let data: Record<string, unknown>;
    try { data = object(JSON.parse((await readText(response, 64 * 1024, signal)).replace(/^\uFEFF/, ""))); }
    catch { fail("WHO returned an invalid OAuth token response", 502); }
    if (typeof data.access_token !== "string" || !data.access_token || /\s/.test(data.access_token) || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) fail("WHO returned invalid OAuth token fields", 502);
    cachedToken = data.access_token;
    cachedClientId = env.ICD11_CLIENT_ID;
    cachedClientSecret = env.ICD11_CLIENT_SECRET;
    // Expire 60 seconds early to avoid edge-case failures
    tokenExpiresAt = now + (data.expires_in - 60) * 1000;

    return cachedToken;
}

/**
 * Fetch from the WHO ICD-11 API with automatic OAuth authentication.
 *
 * @param path - API path relative to https://id.who.int/icd (e.g., "/entity/search")
 * @param env - Environment with ICD11_CLIENT_ID and ICD11_CLIENT_SECRET
 * @param init - Optional fetch RequestInit overrides
 */
export async function icd11Fetch(
    path: string,
    env: Icd11Env,
    init?: RequestInit,
): Promise<Response> {
    const pathname = path.split("?")[0];
    if (!path.startsWith("/") || /[\\#]/.test(path) || pathname.includes("..") || /%(?:2e|2f|5c)/i.test(pathname)) fail("Invalid WHO API path");
    const url = `${ICD11_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    return authorizedFetch(url, env, init);
}

/** FHIR lives under /fhir, alongside /icd, never under /icd/fhir. */
export async function icd11FhirFetch(path: string, env: Icd11Env, init?: RequestInit): Promise<Response> {
    if (!path.startsWith("/fhir/") || path.includes("..") || path.includes("\\")) fail("Invalid WHO FHIR path");
    return authorizedFetch(`https://id.who.int${path}`, env, init);
}

/** Withhold an unexpected credential echo rather than returning secrets in diagnostics. */
export function redactCredentialEcho(text: string, env: Icd11Env, response?: Response): string {
    const secrets = [env.ICD11_CLIENT_ID, env.ICD11_CLIENT_SECRET, ...(response ? responseTokens.get(response) ?? [] : [cachedToken])].filter((value): value is string => Boolean(value));
    const redact = (input: string) => {
        let value = input;
        for (const secret of secrets) for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) value = value.split(form).join("[REDACTED]");
        return value;
    };
    return redact(text.replace(/"(?:[^"\\]|\\.)*"/g, token => {
        try { const decoded = JSON.parse(token) as string; const safe = redact(decoded); return safe === decoded ? token : JSON.stringify(safe); }
        catch { return token; }
    }));
}

async function authorizedFetch(url: string, env: Icd11Env, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? AbortSignal.timeout(45_000);
    const token = await getAccessToken(env, signal);

    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "API-Version": "v2",
        "Accept-Language": "en",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
    };

    const response = await boundedFetch(url, {
        ...init,
        headers,
        signal,
        redirect: "manual",
    });

    // If 401, token may have been invalidated — retry once with fresh token
    if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        cachedToken = null;
        tokenExpiresAt = 0;
        const freshToken = await getAccessToken(env, signal);
        const retryHeaders: Record<string, string> = {
            ...headers,
            Authorization: `Bearer ${freshToken}`,
        };
        const retried = await boundedFetch(url, { ...init, headers: retryHeaders, signal, redirect: "manual" });
        responseTokens.set(retried, [token, freshToken]);
        return retried;
    }
    responseTokens.set(response, [token]);
    return response;
}
