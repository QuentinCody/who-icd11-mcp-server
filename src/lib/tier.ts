import type { Icd11Env } from "./http";

/** What the keyless tier cannot answer — only the gated id.who.int API has these. */
export const KEYLESS_GAPS = [
    "entity definitions and long descriptions",
    "synonyms and index terms",
    "inclusion and exclusion notes",
    "foundation-layer search and flexisearch scoring",
    "/autocode free-text coding",
    "postcoordination axes",
    "DORIS cause-of-death logic",
    "languages other than the English release file",
];

export const KEYLESS_PATHS =
    "/offline/status, /offline/mms/search?q=, /offline/mms/code/{code}, " +
    "/offline/mms/entity/{entityId}, /offline/mms/children/{entityId}, " +
    "/offline/mms/rows, /offline/nlm/search?terms=";

export function hasLiveCredentials(env: Icd11Env): boolean {
    return Boolean(env.ICD11_CLIENT_ID) && Boolean(env.ICD11_CLIENT_SECRET);
}

/**
 * A missing credential is an error, never a silent downgrade: the gated API and
 * the release file are different datasets, so a caller that asked for a
 * definition must be told it cannot have one — and told exactly where the
 * keyless data lives.
 */
export function credentialError(path: string): Error {
    return new Error(
        "WHO ICD-11 API credential missing: ICD11_CLIENT_ID / ICD11_CLIENT_SECRET are not set " +
            `on this Worker, so the gated https://id.who.int/icd endpoints (including ${path}) ` +
            "cannot be called. Register free at https://icd.who.int/icdapi/Account/Register, then " +
            `set both with 'wrangler secret put'. Available WITHOUT a credential right now: ` +
            `${KEYLESS_PATHS} — WHO's own MMS release file plus the NLM mirror, which carry codes, ` +
            `titles, hierarchy, chapters and groupings but NOT ${KEYLESS_GAPS.join(", ")}.`,
    );
}
