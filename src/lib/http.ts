/**
 * WHO ICD-11 API HTTP client with OAuth 2.0 client credentials flow.
 *
 * Token endpoint: https://icdaccessmanagement.who.int/connect/token
 * API base: https://id.who.int/icd
 */

const TOKEN_URL = "https://icdaccessmanagement.who.int/connect/token";
const ICD11_BASE = "https://id.who.int/icd";

export interface Icd11Env {
    ICD11_CLIENT_ID?: string;
    ICD11_CLIENT_SECRET?: string;
}

// Module-level token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Fetch an OAuth 2.0 access token using client credentials grant.
 * Caches the token until 60 seconds before expiry.
 */
async function getAccessToken(env: Icd11Env): Promise<string> {
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
    if (cachedToken && now < tokenExpiresAt) {
        return cachedToken;
    }

    const body = new URLSearchParams({
        client_id: env.ICD11_CLIENT_ID,
        client_secret: env.ICD11_CLIENT_SECRET,
        scope: "icdapi_access",
        grant_type: "client_credentials",
    });

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`ICD-11 token fetch failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    cachedToken = data.access_token;
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
    const token = await getAccessToken(env);

    const url = `${ICD11_BASE}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "API-Version": "v2",
        "Accept-Language": "en",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
    };

    const response = await fetch(url, {
        ...init,
        headers,
    });

    // If 401, token may have been invalidated — retry once with fresh token
    if (response.status === 401) {
        cachedToken = null;
        tokenExpiresAt = 0;
        const freshToken = await getAccessToken(env);
        const retryHeaders: Record<string, string> = {
            ...headers,
            Authorization: `Bearer ${freshToken}`,
        };
        return fetch(url, { ...init, headers: retryHeaders });
    }

    return response;
}
