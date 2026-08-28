import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { type Icd11Env, icd11Fetch } from "./http";
import { nlmSearch as defaultNlmSearch, type NlmSearchResult } from "./nlm";
import {
    DEFAULT_RELEASE,
    entityIdFromUri,
    type Icd11Record,
    type Icd11Release,
    loadRelease as defaultLoadRelease,
    releaseRecord,
    releaseRow,
} from "./offline-release";

/** Injection seam so the routing can be tested without touching the network. */
export interface Icd11AdapterDeps {
    loadRelease?: (release: string) => Promise<Icd11Release>;
    nlmSearch?: (
        terms: string,
        options?: { limit?: number; offset?: number },
    ) => Promise<NlmSearchResult>;
}

/** What the keyless tier cannot answer — only the gated id.who.int API has these. */
const KEYLESS_GAPS = [
    "entity definitions and long descriptions",
    "synonyms and index terms",
    "inclusion and exclusion notes",
    "foundation-layer search and flexisearch scoring",
    "/autocode free-text coding",
    "postcoordination axes",
    "DORIS cause-of-death logic",
    "languages other than the English release file",
];

const KEYLESS_PATHS =
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
function credentialError(path: string): Error {
    return new Error(
        "WHO ICD-11 API credential missing: ICD11_CLIENT_ID / ICD11_CLIENT_SECRET are not set " +
            `on this Worker, so the gated https://id.who.int/icd endpoints (including ${path}) ` +
            "cannot be called. Register free at https://icd.who.int/icdapi/Account/Register, then " +
            `set both with 'wrangler secret put'. Available WITHOUT a credential right now: ` +
            `${KEYLESS_PATHS} — WHO's own MMS release file plus the NLM mirror, which carry codes, ` +
            `titles, hierarchy, chapters and groupings but NOT ${KEYLESS_GAPS.join(", ")}.`,
    );
}

// ── Param helpers ────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

function text(params: Params, name: string): string {
    const value = params[name];
    return value === undefined || value === null ? "" : String(value).trim();
}

function integer(params: Params, name: string, fallback: number, max: number): number {
    const raw = Number(params[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(Math.max(Math.trunc(raw), 0), max);
}

function releaseOf(params: Params): string {
    const release = text(params, "release");
    if (!release) return DEFAULT_RELEASE;
    if (!/^\d{4}-\d{2}$/.test(release)) {
        throw new Error(`Invalid release '${release}'. Use WHO's form, e.g. 2026-01 or 2025-01.`);
    }
    return release;
}

/**
 * Reject a parameter this endpoint does not know, exactly as filterRows rejects
 * an unknown column. A dropped filter is the worst failure mode here:
 * `class_knd: 'category'` would otherwise return the UNFILTERED hit set, which
 * looks like a filtered answer and is wrong by more rows than it is right.
 */
function assertKnownParams(endpoint: string, params: Params, allowed: string[]): void {
    const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
    if (unknown.length === 0) return;
    throw new Error(
        `Unknown parameter${unknown.length > 1 ? "s" : ""} ` +
            `${unknown.map((key) => `'${key}'`).join(", ")} on ${endpoint}. ` +
            `Accepted: ${allowed.join(", ")}. An unrecognised parameter is rejected, never ` +
            "ignored — a mistyped filter must not return a wider result set that looks filtered.",
    );
}

// ── Provenance envelope ──────────────────────────────────────────────────

function releaseProvenance(rel: Icd11Release): Record<string, unknown> {
    return {
        dataset: `ICD-11 MMS Simple Tabulation, release ${rel.release}`,
        publisher: "World Health Organization",
        source: "icdcdn.who.int",
        source_url: rel.sourceUrl,
        release: rel.release,
        release_version: rel.versionStamp,
        retrieved_at: new Date(rel.fetchedAt).toISOString(),
        row_count: rel.lines.length,
        not_from: "https://id.who.int/icd (the gated ICD-11 API)",
        not_available_in_this_tier: KEYLESS_GAPS,
    };
}

function nlmProvenance(result: NlmSearchResult): Record<string, unknown> {
    return {
        dataset: "NLM Clinical Tables — ICD-11 stem and extension codes (WHO-sourced)",
        publisher: "U.S. National Library of Medicine",
        source: "clinicaltables.nlm.nih.gov",
        source_url: result.requestUrl,
        retrieved_at: new Date().toISOString(),
        not_from: "https://id.who.int/icd (the gated ICD-11 API)",
        not_available_in_this_tier: KEYLESS_GAPS,
    };
}

function keyless(provenance: Record<string, unknown>, payload: Record<string, unknown>) {
    return {
        status: 200,
        data: { tier: "keyless_offline", degraded: true, provenance, ...payload },
    };
}

// ── Offline queries ──────────────────────────────────────────────────────

/**
 * Releases before 2026-01 ship 17 columns and no Parent column, so hierarchy
 * walking is genuinely impossible there rather than merely empty.
 */
function hasParentColumn(rel: Icd11Release): boolean {
    return rel.columns.indexOf("parent_uri") !== -1;
}

/** Walk parent_entity_id up to the chapter so a code lookup carries its context. */
function ancestorsOf(rel: Icd11Release, record: Icd11Record): Icd11Record[] {
    const chain: Icd11Record[] = [];
    let parentId = String(record.parent_entity_id ?? "");
    for (let hop = 0; hop < 12 && parentId; hop++) {
        const index = rel.byEntity.get(parentId);
        if (index === undefined) break;
        const parent = releaseRecord(rel, index);
        chain.push(parent);
        parentId = String(parent.parent_entity_id ?? "");
    }
    return chain;
}

function childrenOf(rel: Icd11Release, entityId: string): number[] {
    const needle = `/icd/entity/${entityId}`;
    const parentIdx = rel.columns.indexOf("parent_uri");
    const found: number[] = [];
    for (let i = 0; i < rel.lines.length; i++) {
        // Cheap prefilter: the parent URI is a substring of the raw record.
        if (!rel.lines[i].includes(needle)) continue;
        const cells = releaseRow(rel, i);
        const parent = (cells[parentIdx] ?? "").trim();
        if (parent.endsWith(needle)) found.push(i);
    }
    return found;
}

/** Rank title matches: exact, then prefix, then word-start, then anywhere. */
function scoreTitle(title: string, query: string, wordStart: RegExp): number {
    if (title === query) return 100;
    if (title.startsWith(query)) return 80;
    if (wordStart.test(title)) return 60;
    return 40;
}

function searchOffline(
    rel: Icd11Release,
    query: string,
    filters: Params,
): { index: number; score: number }[] {
    const normalized = query.toLowerCase().trim();
    const terms = normalized.split(/\s+/).filter(Boolean);
    const wordStart = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const classKind = text(filters, "class_kind").toLowerCase();
    const chapter = text(filters, "chapter_no").toLowerCase();
    const residual = text(filters, "is_residual").toLowerCase();
    const leaf = text(filters, "is_leaf").toLowerCase();
    const needsRow = Boolean(classKind || chapter || residual || leaf);

    const kindIdx = rel.columns.indexOf("class_kind");
    const chapterIdx = rel.columns.indexOf("chapter_no");
    const residualIdx = rel.columns.indexOf("is_residual");
    const leafIdx = rel.columns.indexOf("is_leaf");

    const hits: { index: number; score: number }[] = [];
    for (let i = 0; i < rel.titlesLower.length; i++) {
        const title = rel.titlesLower[i];
        let matched = true;
        for (const term of terms) {
            if (!title.includes(term)) {
                matched = false;
                break;
            }
        }
        if (!matched) continue;
        if (needsRow) {
            const cells = releaseRow(rel, i);
            const cell = (index: number) => (cells[index] ?? "").trim().toLowerCase();
            if (classKind && cell(kindIdx) !== classKind) continue;
            if (chapter && cell(chapterIdx) !== chapter) continue;
            if (residual && cell(residualIdx) !== residual) continue;
            if (leaf && cell(leafIdx) !== leaf) continue;
        }
        hits.push({ index: i, score: scoreTitle(title, normalized, wordStart) });
    }
    hits.sort(
        (a, b) =>
            b.score - a.score ||
            rel.titlesLower[a.index].length - rel.titlesLower[b.index].length,
    );
    return hits;
}

/**
 * Columns `releaseRecord` derives rather than reads: the numeric entity id at
 * the end of a WHO URI. They are in every returned record and in the staged
 * table, so they are filterable here too — advertising a filter that then
 * throws "Unknown filter column" is the same defect as dropping one silently.
 * Derived ids match EXACTLY (they are identifiers); raw columns match by
 * case-insensitive substring.
 */
const DERIVED_FILTER_COLUMNS: Record<string, string> = {
    entity_id: "foundation_uri",
    parent_entity_id: "parent_uri",
};

/** Derived columns this release can actually serve (parent_uri is 2026-01+). */
function derivedColumnsOf(rel: Icd11Release): string[] {
    return Object.keys(DERIVED_FILTER_COLUMNS).filter(
        (name) => rel.columns.indexOf(DERIVED_FILTER_COLUMNS[name]) !== -1,
    );
}

function filterableColumns(rel: Icd11Release): string[] {
    return rel.columns.concat(derivedColumnsOf(rel));
}

/** Case-insensitive substring filter on any column — the staging workhorse. */
function filterRows(rel: Icd11Release, params: Params): number[] {
    const filters: { column: number; value: string; derived: boolean }[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (key === "limit" || key === "offset" || key === "release") continue;
        const derivedFrom = DERIVED_FILTER_COLUMNS[key];
        const column = rel.columns.indexOf(derivedFrom ?? key);
        if (column === -1) {
            throw new Error(
                derivedFrom
                    ? `Filter column '${key}' is derived from '${derivedFrom}', which release ` +
                      `${rel.release} does not ship. Columns: ${filterableColumns(rel).join(", ")}.`
                    : `Unknown filter column '${key}'. Columns: ${filterableColumns(rel).join(", ")}.`,
            );
        }
        if (value === undefined || value === null || value === "") continue;
        filters.push({
            column,
            value: String(value).trim().toLowerCase(),
            derived: derivedFrom !== undefined,
        });
    }

    const matched: number[] = [];
    for (let i = 0; i < rel.lines.length; i++) {
        if (filters.length === 0) {
            matched.push(i);
            continue;
        }
        const cells = releaseRow(rel, i);
        let ok = true;
        for (const filter of filters) {
            const raw = cells[filter.column] ?? "";
            if (filter.derived) {
                if (entityIdFromUri(raw).toLowerCase() !== filter.value) {
                    ok = false;
                    break;
                }
                continue;
            }
            if (!raw.toLowerCase().includes(filter.value)) {
                ok = false;
                break;
            }
        }
        if (ok) matched.push(i);
    }
    return matched;
}

function page(indexes: number[], offset: number, limit: number): number[] {
    return indexes.slice(offset, offset + limit);
}

async function handleOffline(
    segments: string[],
    params: Params,
    deps: Required<Icd11AdapterDeps>,
): Promise<{ status: number; data: unknown }> {
    const rest = segments.slice(1); // drop "offline"
    const head = rest[0] ?? "";

    if (head === "nlm" && rest[1] === "search") {
        assertKnownParams("/offline/nlm/search", params, ["terms", "q", "limit", "offset"]);
        const terms = text(params, "terms") || text(params, "q");
        if (!terms) throw new Error("/offline/nlm/search requires a 'terms' (or 'q') parameter");
        const result = await deps.nlmSearch(terms, {
            limit: integer(params, "limit", 20, 500),
            offset: integer(params, "offset", 0, 100_000),
        });
        return keyless(nlmProvenance(result), {
            query: { terms },
            total_matched: result.total,
            returned: result.returned,
            offset: result.offset,
            limit: result.limit,
            results: result.results,
        });
    }

    const rel = await deps.loadRelease(releaseOf(params));

    if (head === "status") {
        assertKnownParams("/offline/status", params, ["release"]);
        return keyless(releaseProvenance(rel), {
            columns: rel.columns,
            // Derived, not in the file: the numeric id at the end of a WHO URI.
            // Listed apart from `columns` so the two lists mean what they say —
            // both are filterable on /offline/mms/rows, but a derived id matches
            // exactly while a raw column matches by substring.
            derived_columns: derivedColumnsOf(rel),
            filterable_columns: filterableColumns(rel),
            filter_semantics:
                "raw columns: case-insensitive substring; derived columns (entity_id, parent_entity_id): exact match",
            coded_entries: rel.byCode.size,
            foundation_entities: rel.byEntity.size,
            supports: {
                hierarchy: hasParentColumn(rel),
                coding_notes: rel.columns.indexOf("coding_note") !== -1,
            },
            endpoints: KEYLESS_PATHS.split(", "),
        });
    }

    if (head !== "mms") {
        throw new Error(
            `Unknown keyless endpoint /${segments.join("/")}. Valid: ${KEYLESS_PATHS}.`,
        );
    }

    const action = rest[1] ?? "";
    const argument = rest.slice(2).join("/");
    const limit = integer(params, "limit", 50, 5000);
    const offset = integer(params, "offset", 0, 1_000_000);

    if (action === "code" || action === "entity") {
        // `entityId` is the catalog's path-param spelling; accept it as a query
        // param too rather than rejecting the name this endpoint documents.
        assertKnownParams(
            `/offline/mms/${action}`,
            params,
            action === "code" ? ["code", "release"] : ["entity_id", "entityId", "release"],
        );
        const key =
            argument ||
            (action === "code"
                ? text(params, "code")
                : text(params, "entity_id") || text(params, "entityId"));
        if (!key) throw new Error(`/offline/mms/${action}/{value} requires a value`);
        const index =
            action === "code"
                ? rel.byCode.get(key.toUpperCase())
                : rel.byEntity.get(key.replace(/^.*\//, ""));
        if (index === undefined) {
            return keyless(releaseProvenance(rel), {
                query: { [action]: key },
                found: false,
                record: null,
                note: `No ${action} '${key}' in the ${rel.release} MMS release file. Codes are case-insensitive (e.g. 5A11, 1C1G.0); residual entries carry a code but no foundation entity id.`,
            });
        }
        const record = releaseRecord(rel, index);
        const hierarchy = hasParentColumn(rel)
            ? { ancestors: ancestorsOf(rel, record) }
            : {
                  ancestors_unavailable: `Release ${rel.release} ships no Parent column, so the ancestor chain cannot be derived. Use release 2026-01.`,
              };
        return keyless(releaseProvenance(rel), {
            query: { [action]: key },
            found: true,
            record,
            ...hierarchy,
        });
    }

    if (action === "children") {
        assertKnownParams("/offline/mms/children", params, [
            "entity_id",
            "entityId",
            "limit",
            "offset",
            "release",
        ]);
        const entityId = (
            argument ||
            text(params, "entity_id") ||
            text(params, "entityId")
        ).replace(/^.*\//, "");
        if (!entityId) throw new Error("/offline/mms/children/{entityId} requires an entity id");
        if (!hasParentColumn(rel)) {
            throw new Error(
                `Release ${rel.release} of the MMS release file ships no Parent column, so children ` +
                    "cannot be resolved from it. Use release 2026-01 (the default).",
            );
        }
        const matched = childrenOf(rel, entityId);
        return keyless(releaseProvenance(rel), {
            query: { entity_id: entityId },
            total_matched: matched.length,
            returned: Math.min(limit, Math.max(matched.length - offset, 0)),
            offset,
            limit,
            results: page(matched, offset, limit).map((i) => releaseRecord(rel, i)),
        });
    }

    if (action === "search") {
        assertKnownParams("/offline/mms/search", params, [
            "q",
            "query",
            "class_kind",
            "chapter_no",
            "is_residual",
            "is_leaf",
            "limit",
            "offset",
            "release",
        ]);
        const query = text(params, "q") || text(params, "query");
        if (!query) throw new Error("/offline/mms/search requires a 'q' parameter");
        const hits = searchOffline(rel, query, params);
        return keyless(releaseProvenance(rel), {
            query: { q: query },
            match: "case-insensitive substring over titles; every whitespace-separated term must appear",
            total_matched: hits.length,
            returned: Math.min(limit, Math.max(hits.length - offset, 0)),
            offset,
            limit,
            results: page(
                hits.map((hit) => hit.index),
                offset,
                limit,
            ).map((i) => releaseRecord(rel, i)),
        });
    }

    if (action === "rows") {
        const matched = filterRows(rel, params);
        return keyless(releaseProvenance(rel), {
            total_unfiltered: rel.lines.length,
            total_matched: matched.length,
            returned: Math.min(limit, Math.max(matched.length - offset, 0)),
            offset,
            limit,
            results: page(matched, offset, limit).map((i) => releaseRecord(rel, i)),
        });
    }

    throw new Error(`Unknown keyless endpoint /${segments.join("/")}. Valid: ${KEYLESS_PATHS}.`);
}

// ── Live (gated) tier ────────────────────────────────────────────────────

async function handleLive(
    path: string,
    params: Params,
    env: Icd11Env,
): Promise<{ status: number; data: unknown }> {
    let target = path;
    const keys = Object.keys(params);
    if (keys.length > 0) {
        const qs = new URLSearchParams();
        for (const key of keys) {
            const value = params[key];
            if (value !== undefined && value !== null) qs.set(key, String(value));
        }
        const query = qs.toString();
        if (query) target = `${target}${target.includes("?") ? "&" : "?"}${query}`;
    }

    const response = await icd11Fetch(target, env);

    if (!response.ok) {
        let errorBody: string;
        try {
            errorBody = await response.text();
        } catch {
            errorBody = response.statusText;
        }
        const error = new Error(
            `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        ) as Error & { status: number; data: unknown };
        error.status = response.status;
        error.data = errorBody;
        throw error;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
        return { status: response.status, data: await response.text() };
    }
    return { status: response.status, data: await response.json() };
}

/**
 * Create an ApiFetchFn for ICD-11 Code Mode execution.
 *
 * Two tiers, addressed by distinct paths so neither can masquerade as the other:
 *   /offline/…  keyless — WHO's MMS release file and the NLM mirror. Always on.
 *   everything else  the gated id.who.int API, which needs the OAuth credential.
 */
export function createIcd11ApiFetch(env: Icd11Env, deps: Icd11AdapterDeps = {}): ApiFetchFn {
    const resolved: Required<Icd11AdapterDeps> = {
        loadRelease: deps.loadRelease ?? defaultLoadRelease,
        nlmSearch: deps.nlmSearch ?? defaultNlmSearch,
    };

    return async (request) => {
        const [rawPath, rawQuery] = request.path.split("?");
        const segments = rawPath.split("/").filter(Boolean);
        const params = (request.params ?? {}) as Params;

        if (segments[0] === "offline") {
            // Accept both api.get(path, {params}) and a query string baked into the path.
            const merged: Params = {};
            if (rawQuery) {
                for (const [key, value] of new URLSearchParams(rawQuery)) merged[key] = value;
            }
            Object.assign(merged, params);
            return handleOffline(segments, merged, resolved);
        }
        if (!hasLiveCredentials(env)) {
            throw credentialError(request.path);
        }
        return handleLive(request.path, params, env);
    };
}
