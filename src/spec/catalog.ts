import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const icd11Catalog: ApiCatalog = {
    name: "WHO ICD-11",
    baseUrl: "https://id.who.int/icd",
    version: "2024-01 (ICD-11 MMS)",
    auth: "oauth2_client_credentials",
    endpointCount: 8,
    notes:
        "- ICD-11 was adopted by WHO in 2019, effective January 2022\n" +
        "- The primary linearization is 'mms' (Mortality and Morbidity Statistics)\n" +
        "- ICD-11 codes are alphanumeric blocks (e.g., BA00, 5A11, CA40.0)\n" +
        "- Codes use a stem + extension model for post-coordination\n" +
        "- Entity IDs are numeric URIs (e.g., 1435254666 for 'Type 2 diabetes mellitus')\n" +
        "- Search supports flexisearch (fuzzy matching) via useFlexisearch=true\n" +
        "- flatResults=true returns a flat list instead of hierarchical results\n" +
        "- The /entity endpoint provides the Foundation layer (all entities)\n" +
        "- The /release/11/{linearizationname} endpoints provide linearized (coded) views\n" +
        "- OAuth token is handled automatically; no auth params needed in code\n" +
        "- All requests include API-Version: v2 and Accept-Language: en headers",
    endpoints: [
        // ── Entity (Foundation) ──
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
                "Get a specific ICD-11 entity by its Foundation ID. Returns title, definition, synonyms, parents, children, exclusions, and coded-in linearizations.",
            category: "entity",
            pathParams: [
                {
                    name: "id",
                    type: "string",
                    required: true,
                    description:
                        "Foundation entity ID (numeric, e.g., 1435254666 for Type 2 diabetes mellitus)",
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
                {
                    name: "q",
                    type: "string",
                    required: true,
                    description: "Search query text (e.g., 'diabetes mellitus', 'lung cancer')",
                },
                {
                    name: "useFlexisearch",
                    type: "boolean",
                    required: false,
                    description:
                        "Enable fuzzy/flexible search matching (default: false). Set to true for broader results.",
                },
                {
                    name: "flatResults",
                    type: "boolean",
                    required: false,
                    description:
                        "Return flat list instead of hierarchical grouping (default: false). Recommended for programmatic use.",
                },
                {
                    name: "subtreeFilterUsesFoundationDescendants",
                    type: "boolean",
                    required: false,
                    description: "Filter using Foundation descendants (default: false)",
                },
                {
                    name: "subtreeFilter",
                    type: "string",
                    required: false,
                    description: "Restrict search to descendants of this entity URI",
                },
            ],
        },
        // ── Linearization ──
        {
            method: "GET",
            path: "/release/11/{linearizationname}",
            summary:
                "Get the root of a linearization (e.g., MMS). Returns top-level chapters and child codes.",
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
                "Look up a specific ICD-11 code in a linearization. Returns code details, title, definition, inclusions, exclusions, and parent/child hierarchy.",
            category: "linearization",
            pathParams: [
                {
                    name: "linearizationname",
                    type: "string",
                    required: true,
                    description: "Linearization name (e.g., 'mms')",
                },
                {
                    name: "code",
                    type: "string",
                    required: true,
                    description:
                        "ICD-11 code (e.g., 'BA00' for essential hypertension, '5A11' for type 2 diabetes, 'CA40.0')",
                },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}/codeinfo/{code}",
            summary:
                "Get detailed code information including stem/extension post-coordination details for a specific ICD-11 code.",
            category: "linearization",
            pathParams: [
                {
                    name: "linearizationname",
                    type: "string",
                    required: true,
                    description: "Linearization name (e.g., 'mms')",
                },
                {
                    name: "code",
                    type: "string",
                    required: true,
                    description: "ICD-11 code (e.g., '5A11' for type 2 diabetes mellitus)",
                },
            ],
        },
        {
            method: "GET",
            path: "/release/11/{linearizationname}/search",
            summary:
                "Search within a specific linearization (e.g., MMS) for codes matching a query. Returns coded results with ICD-11 codes, scores, and chapter info.",
            category: "linearization",
            queryParams: [
                {
                    name: "q",
                    type: "string",
                    required: true,
                    description: "Search query text",
                },
                {
                    name: "useFlexisearch",
                    type: "boolean",
                    required: false,
                    description: "Enable fuzzy/flexible matching (default: false)",
                },
                {
                    name: "flatResults",
                    type: "boolean",
                    required: false,
                    description: "Return flat list (default: false). Recommended for programmatic use.",
                },
                {
                    name: "subtreeFilterUsesFoundationDescendants",
                    type: "boolean",
                    required: false,
                    description: "Filter using Foundation descendants",
                },
                {
                    name: "subtreeFilter",
                    type: "string",
                    required: false,
                    description: "Restrict search to descendants of this entity URI",
                },
            ],
        },
        // ── Coding Tool ──
        {
            method: "GET",
            path: "/release/11/mms/autocode",
            summary:
                "Auto-code free text to ICD-11 MMS codes. Accepts clinical descriptions and returns the best matching ICD-11 code(s) with confidence scores.",
            category: "coding_tool",
            queryParams: [
                {
                    name: "searchText",
                    type: "string",
                    required: true,
                    description:
                        "Free text clinical description to auto-code (e.g., 'type 2 diabetes with kidney complications')",
                },
            ],
        },
    ],
};
