/**
 * Keyless tier — NLM Clinical Tables ICD-11 mirror.
 *
 * `clinicaltables.nlm.nih.gov/api/icd11_codes/v3/search` is NIH's public,
 * registration-free text index over WHO's ICD-11 stem and extension codes
 * (35,664 records, data version 2026-01). It gives the keyless tier a real
 * ranked text search; it is NOT the WHO API and carries no definitions,
 * synonyms, inclusion/exclusion notes or postcoordination.
 */

import { restFetch } from "@bio-mcp/shared/http/rest-fetch";

const NLM_BASE = "https://clinicaltables.nlm.nih.gov/api/icd11_codes/v3";

export interface NlmHit {
    code: string;
    title: string;
    /** "stem" or "extension" — extension codes only post-coordinate a stem code. */
    type: string;
}

export interface NlmSearchResult {
    /** Total matches upstream, which can exceed the returned page. */
    total: number;
    returned: number;
    offset: number;
    limit: number;
    /** The exact URL this result came from, for replay. */
    requestUrl: string;
    results: NlmHit[];
}

/**
 * NLM answers with a positional array:
 * [total, [codes…], null, [[code, title, type], …]]
 */
function parseNlmPayload(payload: unknown): { total: number; rows: string[][] } {
    if (!Array.isArray(payload) || payload.length < 4) {
        throw new Error("Unexpected NLM Clinical Tables response shape");
    }
    const total = typeof payload[0] === "number" ? payload[0] : 0;
    const rows = Array.isArray(payload[3]) ? (payload[3] as string[][]) : [];
    return { total, rows };
}

export async function nlmSearch(
    terms: string,
    options: { limit?: number; offset?: number } = {},
): Promise<NlmSearchResult> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const params = {
        terms,
        sf: "code,title",
        df: "code,title,type",
        maxList: limit,
        offset,
    };

    // restFetch defaults its whole-call deadline to `timeout`, so a per-attempt
    // timeout equal to the budget consumes it and the retries never fire on the
    // failure they exist for — a stall. Measured against a local server that
    // accepts and never answers: {timeout: 15_000, retries: 2} made exactly ONE
    // connection in 15 s, while the pair below made three (the attempt plus both
    // retries) inside the 20 s budget.
    const response = await restFetch(NLM_BASE, "/search", params, {
        timeout: 8_000,
        deadlineMs: 20_000,
        retries: 2,
        rateLimitKey: "nlm-clinical-tables",
    });
    const requestUrl = response.url || `${NLM_BASE}/search`;
    if (!response.ok) {
        const body = await response.text().catch(() => response.statusText);
        throw new Error(
            `NLM Clinical Tables search failed (${response.status}): ${body.slice(0, 200)}`,
        );
    }

    const { total, rows } = parseNlmPayload(await response.json());
    return {
        total,
        returned: rows.length,
        offset,
        limit,
        requestUrl,
        results: rows.map((row) => ({
            code: row[0] ?? "",
            title: row[1] ?? "",
            type: row[2] ?? "",
        })),
    };
}
