import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

/**
 * Two tiers live in one catalog, on paths that cannot be confused:
 *
 *   gated   — https://id.who.int/icd, the real ICD-11 API. Needs the free WHO
 *             OAuth credential (ICD11_CLIENT_ID / ICD11_CLIENT_SECRET). Only
 *             this tier has definitions, synonyms, exclusions, autocode and
 *             postcoordination.
 *   /offline — keyless. WHO's own published MMS release file plus NLM's mirror.
 *             Always available, and honest about what it drops.
 */
export const icd11Catalog: ApiCatalog = {
    name: "WHO ICD-11",
    baseUrl: "https://id.who.int/icd",
    version: "MMS release 2026-01 · gated API v2",
    auth: "oauth2_client_credentials (gated endpoints) | none (/offline/* endpoints)",
    endpointCount: 16,
    notes:
        "- TWO TIERS. Gated endpoints (/entity*, /release/11/*) call https://id.who.int/icd and need the free WHO API credential. Keyless endpoints (/offline/*) need nothing and are always available.\n" +
        "- If the credential is absent, a gated call FAILS with an error naming the /offline path to use instead. It is never silently answered from the release file — the two are different datasets.\n" +
        "- KEYLESS TIER SOURCES: WHO's own https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip (37,052 rows) and https://clinicaltables.nlm.nih.gov/api/icd11_codes/v3/search (35,664 stem+extension codes, NLM/NIH mirror of WHO data).\n" +
        "- KEYLESS TIER LOSES: definitions, synonyms/index terms, inclusion & exclusion notes, foundation search with flexisearch scores, /autocode, postcoordination axes, DORIS, and non-English text. It is a yearly snapshot, so mid-year ICD-11 updates lag. Every /offline response carries tier:'keyless_offline', degraded:true and a provenance block naming icdcdn.who.int or clinicaltables.nlm.nih.gov — never id.who.int.\n" +
        "- KEYLESS TIER KEEPS: the full MMS linearization — code, title, class kind (chapter/block/category), chapter number, block id, depth, residual and leaf flags, groupings, coding notes, parent entity, and the browser link.\n" +
        "- ICD-11 codes are alphanumeric (BA00, 5A11, CA40.0); '.Z' and '.Y' suffixes mark residual (unspecified / other specified) categories.\n" +
        "- Entity ids are numeric: 119724091 = 'Type 2 diabetes mellitus' (MMS code 5A11); 1435254666 = 'Certain infectious or parasitic diseases' (chapter 01). Residual rows have a code but NO foundation entity id.\n" +
        "- The primary linearization is 'mms' (Mortality and Morbidity Statistics). Current releases are 2026-01 and 2025-01; an unpinned /release/11/mms/... path serves WHO's latest.\n" +
        "- Gated tier: search supports useFlexisearch=true (fuzzy) and flatResults=true (flat list, easier to program against). OAuth is handled for you; never put credentials in code.\n" +
        "- All gated requests send API-Version: v2 and Accept-Language: en.\n" +
        "- KEYLESS PARAMS ARE VALIDATED: every /offline/* endpoint rejects a parameter it does not know (and /offline/mms/rows rejects an unknown filter column) instead of ignoring it, so a typo like class_knd fails loudly rather than returning the unfiltered set.\n" +
        "- api.get(path, params) returns the response BODY directly — there is no .data wrapper. Keyless bodies are { tier, degraded, provenance, ... }.",
    endpoints: [
        // ── Keyless tier — WHO release file + NLM mirror (no credential) ──
        {
            method: "GET",
            path: "/offline/status",
            summary:
                "Keyless tier health: which MMS release is cached, WHO's build stamp, row/code counts, the exact source archive, and the filter surface — `columns` (raw file columns), `derived_columns` (entity_id, parent_entity_id) and `filterable_columns` (both, all usable on /offline/mms/rows). Start here when no credential is configured.",
            category: "keyless",
            featured: true,
            queryParams: [
                {
                    name: "release",
                    type: "string",
                    required: false,
                    description: "WHO release, e.g. '2026-01' (default) or '2025-01'",
                },
            ],
            example: "const s = await api.get('/offline/status'); console.log(s.provenance, s.supports);",
        },
        {
            method: "GET",
            path: "/offline/mms/search",
            summary:
                "Keyless text search over MMS titles. Every whitespace-separated term must appear in the title (case-insensitive); hits are ranked exact > prefix > word-start > anywhere. No definitions or synonyms — titles only.",
            category: "keyless",
            featured: true,
            queryParams: [
                { name: "q", type: "string", required: true, description: "Search text, e.g. 'type 2 diabetes'" },
                { name: "class_kind", type: "string", required: false, description: "Restrict to 'chapter', 'block' or 'category'" },
                { name: "chapter_no", type: "string", required: false, description: "Restrict to a chapter, e.g. '05'" },
                { name: "is_leaf", type: "string", required: false, description: "'true' or 'false'" },
                { name: "is_residual", type: "string", required: false, description: "'true' or 'false' (residual = other specified / unspecified)" },
                { name: "limit", type: "number", required: false, description: "Max rows (default 50, max 5000)" },
                { name: "offset", type: "number", required: false, description: "Rows to skip (default 0)" },
                { name: "release", type: "string", required: false, description: "WHO release (default 2026-01)" },
            ],
            example:
                "const r = await api.get('/offline/mms/search', { q: 'type 2 diabetes', class_kind: 'category', limit: 10 });",
        },
        {
            method: "GET",
            path: "/offline/mms/code/{code}",
            summary:
                "Keyless lookup of one ICD-11 MMS code, with its ancestor chain up to the chapter. Returns found:false (not an error) when the code is absent from the release.",
            category: "keyless",
            featured: true,
            pathParams: [
                { name: "code", type: "string", required: true, description: "ICD-11 code, case-insensitive, e.g. '5A11' or '1C1G.0'" },
            ],
            queryParams: [
                { name: "release", type: "string", required: false, description: "WHO release (default 2026-01)" },
            ],
            example: "const r = await api.get('/offline/mms/code/5A11');",
        },
        {
            method: "GET",
            path: "/offline/mms/entity/{entityId}",
            summary:
                "Keyless lookup by Foundation entity id (the numeric id in a WHO URI), with its ancestor chain. Residual rows carry no entity id — look those up by code.",
            category: "keyless",
            pathParams: [
                { name: "entityId", type: "string", required: true, description: "Numeric entity id, e.g. '119724091'" },
            ],
            queryParams: [
                { name: "release", type: "string", required: false, description: "WHO release (default 2026-01)" },
            ],
        },
        {
            method: "GET",
            path: "/offline/mms/children/{entityId}",
            summary:
                "Keyless hierarchy walk: the direct children of one entity in the MMS linearization, in release order.",
            category: "keyless",
            pathParams: [
                { name: "entityId", type: "string", required: true, description: "Parent entity id, e.g. '1435254666' for chapter 01" },
            ],
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max rows (default 50, max 5000)" },
                { name: "offset", type: "number", required: false, description: "Rows to skip" },
                { name: "release", type: "string", required: false, description: "WHO release (default 2026-01)" },
            ],
        },
        {
            method: "GET",
            path: "/offline/mms/rows",
            summary:
                "Keyless bulk access to the release table. Any column name becomes a case-insensitive substring filter; the derived ids entity_id and parent_entity_id filter by exact match. An unknown column is an error, not an ignored filter. With no filter it returns the whole linearization page by page. Large pages auto-stage — then use icd11_query_data for SQL. /offline/status lists this release's columns, derived_columns and filterable_columns.",
            category: "keyless",
            queryParams: [
                { name: "chapter_no", type: "string", required: false, description: "Chapter, e.g. '05'" },
                { name: "class_kind", type: "string", required: false, description: "'chapter', 'block' or 'category'" },
                { name: "code", type: "string", required: false, description: "Substring of the code, e.g. '5A1'" },
                { name: "title", type: "string", required: false, description: "Substring of the title" },
                { name: "block_id", type: "string", required: false, description: "Block id, e.g. 'BlockL1-5A0'" },
                { name: "grouping1", type: "string", required: false, description: "Top-level grouping block id" },
                { name: "entity_id", type: "string", required: false, description: "Derived from Foundation URI; exact match, e.g. '119724091'" },
                { name: "parent_entity_id", type: "string", required: false, description: "Derived from the Parent URI; exact match — the children of one entity (2026-01+ only)" },
                { name: "is_residual", type: "string", required: false, description: "'true' or 'false'" },
                { name: "is_leaf", type: "string", required: false, description: "'true' or 'false'" },
                { name: "limit", type: "number", required: false, description: "Max rows (default 50, max 5000)" },
                { name: "offset", type: "number", required: false, description: "Rows to skip" },
                { name: "release", type: "string", required: false, description: "WHO release (default 2026-01)" },
            ],
            example:
                "const r = await api.get('/offline/mms/rows', { chapter_no: '05', class_kind: 'category', limit: 2000 });",
        },
        {
            method: "GET",
            path: "/offline/nlm/search",
            summary:
                "Keyless ranked text search through NLM Clinical Tables' WHO-sourced ICD-11 index (stem AND extension codes). Complements /offline/mms/search, which only sees the MMS release file.",
            category: "keyless",
            queryParams: [
                { name: "terms", type: "string", required: true, description: "Search text, e.g. 'lyme'" },
                { name: "limit", type: "number", required: false, description: "Max rows (default 20, max 500)" },
                { name: "offset", type: "number", required: false, description: "Rows to skip" },
            ],
            example: "const r = await api.get('/offline/nlm/search', { terms: 'lyme', limit: 10 });",
        },

        // ── Gated tier — id.who.int (needs the WHO OAuth credential) ──
        {
            method: "GET",
            path: "/entity",
            summary: "Get the root entity of the ICD-11 Foundation. Returns top-level child entity URIs.",
            category: "entity",
        },
        {
            method: "GET",
            path: "/entity/{id}",
            summary:
                "Get a specific ICD-11 entity by its Foundation ID. Returns title, definition, synonyms, parents, children, exclusions, and coded-in linearizations. Definitions and synonyms exist ONLY here, not in the keyless tier.",
            category: "entity",
            pathParams: [
                {
                    name: "id",
                    type: "string",
                    required: true,
                    description:
                        "Foundation entity ID (numeric, e.g. 119724091 = Type 2 diabetes mellitus; 1435254666 = Certain infectious or parasitic diseases)",
                },
            ],
        },
        {
            method: "GET",
            path: "/entity/search",
            summary:
                "Search ICD-11 Foundation entities by text. Returns matching entities with scores, titles, and chapter info. Supports flexible/fuzzy matching.",
            category: "entity",
            queryParams: [
                { name: "q", type: "string", required: true, description: "Search query text (e.g., 'diabetes mellitus', 'lung cancer')" },
                { name: "useFlexisearch", type: "boolean", required: false, description: "Enable fuzzy/flexible search matching (default: false). Set to true for broader results." },
                { name: "flatResults", type: "boolean", required: false, description: "Return flat list instead of hierarchical grouping (default: false). Recommended for programmatic use." },
                { name: "subtreeFilterUsesFoundationDescendants", type: "boolean", required: false, description: "Filter using Foundation descendants (default: false)" },
                { name: "subtreeFilter", type: "string", required: false, description: "Restrict search to descendants of this entity URI" },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}",
            summary: "Get the root of a linearization (e.g. MMS) in WHO's latest release. Returns top-level chapters and child codes.",
            category: "linearization",
            pathParams: [
                {
                    name: "linearizationname",
                    type: "string",
                    required: true,
                    description:
                        "Linearization name: 'mms' (Mortality and Morbidity Statistics, primary clinical coding) or 'icf' (International Classification of Functioning)",
                },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}/{code}",
            summary:
                "Look up a specific ICD-11 code in WHO's latest release of a linearization. Returns code details, title, definition, inclusions, exclusions, and parent/child hierarchy.",
            category: "linearization",
            pathParams: [
                { name: "linearizationname", type: "string", required: true, description: "Linearization name (e.g., 'mms')" },
                { name: "code", type: "string", required: true, description: "ICD-11 code (e.g. 'BA00' essential hypertension, '5A11' type 2 diabetes mellitus, 'CA40.0')" },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{releaseId}/{linearizationname}/{code}",
            summary:
                "Same lookup pinned to one published release, so a result is reproducible. Use this when a coding decision must be attributable to a release.",
            category: "linearization",
            pathParams: [
                { name: "releaseId", type: "string", required: true, description: "Release id, e.g. '2026-01' (current) or '2025-01'" },
                { name: "linearizationname", type: "string", required: true, description: "Linearization name (e.g., 'mms')" },
                { name: "code", type: "string", required: true, description: "ICD-11 code, e.g. '5A11'" },
            ],
            example: "const r = await api.get('/release/11/2026-01/mms/5A11');",
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}/codeinfo/{code}",
            summary:
                "Get detailed code information including stem/extension post-coordination details for a specific ICD-11 code. Post-coordination exists only in this gated tier.",
            category: "linearization",
            pathParams: [
                { name: "linearizationname", type: "string", required: true, description: "Linearization name (e.g., 'mms')" },
                { name: "code", type: "string", required: true, description: "ICD-11 code (e.g. '5A11' for type 2 diabetes mellitus)" },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}/search",
            summary:
                "Search within a specific linearization (e.g. MMS) for codes matching a query. Returns coded results with ICD-11 codes, scores, and chapter info.",
            category: "linearization",
            queryParams: [
                { name: "q", type: "string", required: true, description: "Search query text" },
                { name: "useFlexisearch", type: "boolean", required: false, description: "Enable fuzzy/flexible matching (default: false)" },
                { name: "flatResults", type: "boolean", required: false, description: "Return flat list (default: false). Recommended for programmatic use." },
                { name: "subtreeFilterUsesFoundationDescendants", type: "boolean", required: false, description: "Filter using Foundation descendants" },
                { name: "subtreeFilter", type: "string", required: false, description: "Restrict search to descendants of this entity URI" },
            ],
        },
        {
            method: "GET",
            path: "/release/11/mms/autocode",
            summary:
                "Auto-code free text to ICD-11 MMS codes. Accepts clinical descriptions and returns the best matching ICD-11 code(s) with confidence scores. Gated tier only — the keyless tier has no equivalent.",
            category: "coding_tool",
            queryParams: [
                {
                    name: "searchText",
                    type: "string",
                    required: true,
                    description: "Free text clinical description to auto-code (e.g., 'type 2 diabetes with kidney complications')",
                },
            ],
        },
    ],
    workflows: [
        {
            title: "Code a term without a WHO credential",
            description:
                "Resolve free text to an ICD-11 MMS code and its chapter context using only keyless sources. Returns titles and hierarchy — NOT definitions or inclusion/exclusion notes, which need the gated API.",
            keywords: ["keyless", "no credential", "code lookup", "offline", "chapter"],
            code: [
                "// api.get returns the response body directly (no .data wrapper).",
                "const hits = await api.get('/offline/mms/search', { q: 'type 2 diabetes', class_kind: 'category', limit: 5 });",
                "const best = hits.results[0];",
                "const detail = await api.get('/offline/mms/code/' + best.code);",
                "return {",
                "  code: best.code,",
                "  title: best.title,",
                "  chapter: best.chapter_no,",
                "  ancestors: detail.ancestors.map((a) => a.title),",
                "  tier: detail.tier,",
                "  source: detail.provenance.source_url,",
                "};",
            ].join("\n"),
        },
    ],
};

/**
 * Copy of the catalog whose notes open with the tier that is actually live on
 * this Worker, so `icd11_search` tells a caller up front whether the gated
 * endpoints will work before it writes a program against them.
 */
export function buildIcd11Catalog(liveApiEnabled: boolean): ApiCatalog {
    const status = liveApiEnabled
        ? "- CREDENTIAL STATUS: configured. Both tiers work; prefer the gated endpoints for definitions, synonyms, exclusions and autocode.\n"
        : "- CREDENTIAL STATUS: NOT configured on this deployment. Gated endpoints (/entity*, /release/11/*) will FAIL. Use the /offline/* endpoints, which need no credential.\n";
    return { ...icd11Catalog, notes: status + (icd11Catalog.notes ?? "") };
}
