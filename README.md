# WHO Icd11 MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream WHO Icd11 API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The server is deployed and ready at:

```
https://who-icd11-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "who-icd11": {
      "command": "npx",
      "args": ["mcp-remote", "https://who-icd11-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8875/mcp` (start it with `./scripts/dev-servers.sh who-icd11`):

```json
{
  "mcpServers": {
    "who-icd11-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8875/mcp"]
    }
  }
}
```

## Tools

- `icd11_search` — discover native REST, pre-release FHIR and keyless API operations and recipes
- `icd11_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `icd11_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `icd11_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.
Each tool also has an `mcp_` alias (for example, `mcp_icd11_execute`).

## Pre-release FHIR and API 2.6 discovery

WHO [API 2.6](https://icd.who.int/docs/icd-api/ReleaseNotes-Version2.6/)
adds release/language metadata at `/entity` (`allreleases`, `availableLanguages`)
and `/release/11/{releaseId}/{linearizationname}` (`availableLanguages`,
`prereleaseLanguages`). Both routes retain the full provider response. Native
API release availability does not prove that a release is available through FHIR.

The separate [WHO FHIR R5 service](https://icd.who.int/docs/icd-api/ICDAPI-FHIR-Support/)
is **pre-release**, at `https://id.who.int/fhir`, alongside the native `/icd`
service. Its documentation still lists classification release **2025-01** as of
this review; the existing offline MMS **2026-01** file is a different surface.
FHIR uses the existing `ICD11_CLIENT_ID` / `ICD11_CLIENT_SECRET` OAuth secrets and
does not fall back to the release file or NLM when unavailable.

| Catalog path | Use |
| --- | --- |
| `/fhir/metadata` | Service capabilities; `mode=terminology` requests terminology capabilities. |
| `/fhir/CodeSystem`, `/fhir/CodeSystem/{id}` | Discover available systems/releases and read returned resource IDs. |
| `/fhir/CodeSystem/$lookup` | Explicit `system`, `version`, `code`, `displayLanguage`; returned version must match. |
| `/fhir/CodeSystem/$validate-code` | Explicit `url`, `version`, `code`, `language`; preserve negative results and provider diagnostics. |
| `/fhir/ValueSet` | Discover postcoordination scale definitions by their canonical URL. |
| `/fhir/ValueSet/$expand` | Expand a release-qualified scale URL in an explicit `displayLanguage`. |
| `/fhir/ValueSet/$validate-code` | Validate a code's scale membership using explicit URL, system, code and language. |

Foundation, MMS and ICF have separate canonical systems. Foundation codes are
full entity URIs; MMS/ICF accept their codes or matching linearization URIs.
Release-qualified code URIs cannot disagree with the requested release. Scale
URLs retain release, linearization, entity and axis. Membership in a scale is
not validation of a whole postcoordinated expression or a clinical decision.

`language` is an adapter-only HTTP `Accept-Language` selector; `displayLanguage`
is the native lookup/expansion parameter and sets the same header. Discovery
defaults to English; terminology operations require explicit language. Preserve
returned designations and translation extensions when assessing language coverage.

Responses retain complete FHIR resources plus `_who_fhir` source URL, retrieval
time, requested scope and separately observed version/language fields. Requested
release, CodeSystem version and ValueSet resource version are distinct. Empty
searches do not establish availability. Validation `result=false` remains a valid
negative answer; omitted version evidence remains unknown. Lookup version
mismatches, malformed resources and HTTP-200 OperationOutcome errors fail explicitly.

The adapter preserves expansion parameters, timestamps, totals, offsets and nested
terms. [FHIR R5 permits hierarchical expansions to ignore paging](https://hl7.org/fhir/R5/valueset-operation-expand.html);
`_who_fhir.expansion` reports that distinction, while flat expansions must honor
requested count/offset. Native paging/filter support still needs live acceptance.
Full results over 30 KiB stage through the shared tools; upstream FHIR reads are
bounded to 2 MiB and a 45-second deadline. Code Mode allows 90 seconds for execution
and staging. OAuth refresh is bounded to one retry and cached per credential pair.

Local fixture tests cover these contracts and lossless staging. Authenticated
FHIR data/release/language coverage and the live MCP contract remain unverified:
the current environment cannot resolve the upstream host or bind the local Worker.

## Two tiers: gated WHO API, keyless release file

WHO's ICD-11 API is registration-gated. This server therefore serves two clearly separated tiers, on paths that cannot be mistaken for one another.

| | Gated tier | Keyless tier |
|---|---|---|
| Paths | `/entity*`, `/release/11/*`, `/fhir/*` | `/offline/*` |
| Upstream | `https://id.who.int/icd` and pre-release `https://id.who.int/fhir` | `https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip` (WHO) and `https://clinicaltables.nlm.nih.gov/api/icd11_codes/v3/search` (NLM/NIH mirror) |
| Credential | `ICD11_CLIENT_ID` + `ICD11_CLIENT_SECRET` | none |
| Has | definitions, synonyms, inclusion/exclusion notes, foundation search, `/autocode`, postcoordination, DORIS, all languages | the full MMS linearization: code, title, class kind, chapter, block, depth, residual/leaf flags, groupings, coding notes, parent entity |

**A missing credential is an error, not a downgrade.** A gated call on a Worker with no credential fails with a message naming the keyless path to use instead; it is never silently answered from the release file, because the two are different datasets. Every keyless response carries `tier: "keyless_offline"`, `degraded: true`, and a `provenance` block naming `icdcdn.who.int` or `clinicaltables.nlm.nih.gov` — never `id.who.int`.

The release file is downloaded once per isolate (range request for the 1.1 MB member, inflated with `DecompressionStream`), parsed, and cached in memory for 24 h — the same bulk-ingest pattern as `fda-purple-book-mcp-server`. Releases 2025-01 and earlier ship 17 columns with no `Parent` column, so hierarchy walking is available only from 2026-01.

Keyless endpoints: `/offline/status`, `/offline/mms/search?q=`, `/offline/mms/code/{code}`, `/offline/mms/entity/{entityId}`, `/offline/mms/children/{entityId}`, `/offline/mms/rows`, `/offline/nlm/search?terms=`.

**Every keyless endpoint rejects a parameter it does not know.** A mistyped filter (`class_knd` for `class_kind`) fails with an error naming the accepted set, because the alternative — dropping it — returns the unfiltered result set dressed as a filtered one. `/offline/status` reports the filter surface as three lists: `columns` (the release file's own columns), `derived_columns` (`entity_id` and `parent_entity_id`, lifted out of the WHO URIs) and `filterable_columns` (both). All of them work on `/offline/mms/rows`; raw columns match by case-insensitive substring, derived ids match exactly. A test asserts that every column `/offline/status` advertises is one `/offline/mms/rows` accepts.

**The `_meta.citation` names the tier, not a guessed upstream.** A citation is issued once per `icd11_execute` program, but each tier has more than one upstream — the keyless tier answers from both `icdcdn.who.int` and `clinicaltables.nlm.nih.gov`, and one program can read from both — so the descriptor names the tier and every upstream it can reach: `icd11-keyless` with no credential, `icd11-credentialed` with one (a credential unlocks `id.who.int` but does not close the keyless paths). Naming a single origin would sign NLM bytes as WHO-archive bytes. A downstream verifier still tells a yearly snapshot from the live API by the source id; the upstream that answered a given call, the release and the WHO build stamp stay in that call's `provenance` block. `test/keyless-tier.mts` gates which id each credential state carries.

## Enabling the gated WHO API

The credential is free and self-service; a human has to fetch it once.

1. Register at <https://icd.who.int/icdapi/Account/Register> (name, organization, country, email, password) and confirm the email.
2. Log in and click **View API access key** to self-issue a `clientid` and `clientsecret`.
3. Bind them to the Worker:

```bash
cd servers/who-icd11-mcp-server
npx wrangler secret put ICD11_CLIENT_ID
npx wrangler secret put ICD11_CLIENT_SECRET
```

Secrets take effect without a redeploy, but re-run the fleet probe afterwards — the Worker answering requests must be the one holding them. For local development put both in `servers/who-icd11-mcp-server/.dev.vars`.

Do **not** reach for WHO's browser token at `https://icd.who.int/browse/gt` or the `/dev11/JsonGet*` Maintenance Platform endpoints. Both return real data and both would make this server a scraper riding someone else's quota.

## Development

```bash
./scripts/dev-servers.sh who-icd11            # run locally (port 8875)
pnpm --filter who-icd11-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---

*Auto-generated baseline README — refine with server-specific detail as needed.*

## Response evidence and staging — October 6, 2026

Authenticated native REST and FHIR reads share a 45-second deadline across OAuth,
the single permitted 401 refresh, response headers and body reads. Bodies are
limited to 2 MiB; token responses to 64 KiB. Redirects and partial HTTP responses
are errors. Cancellation does not wait for an upstream cancellation promise.
OAuth response bodies are withheld; API errors preserve sanitized source evidence.

`_mcp.provenance` retains the complete source JSON text, original UTF-8 byte count
and SHA-256, request context and retrieval time. It preserves BOM/whitespace and
native metadata collisions. Credential echoes, including URL encoding and escaped
JSON strings, are redacted and remain errors. The original-byte hash identifies
the received body; redacted text is explicitly marked and is not byte-identical.
FHIR release/type/page validation errors retain the full provider resource.
`result=false` remains a valid negative validation answer.

All eight tool aliases cite successes and errors, and stage complete MCP envelopes
above 30 KiB with space reserved for SDK metadata. Gated API response completeness
stays conservative through nested staging. A returned page, requested language or
matching lookup release does not prove full classification/translation coverage.

Staged FHIR data exposes `fhir_response` (complete native resource),
`fhir_parameters` (ordered parameters and nested parts), `fhir_contains` (ordered
expansion hierarchy) and `fhir_entries` (ordered Bundle entries). Each row retains
native JSON; paths, parent paths and sibling indices preserve repeated names/codes.
Serialized evidence remains in `payloads`; large SQL results restage in `query_rows`.
Keyless results retain `mms_rows` and distinct WHO-archive/NLM provenance.

The [response review](../../docs/audits/2026-10-06-who-icd11-response-review.md)
records synthetic MCP/SQLite acceptance. Authenticated provider behavior and the
edited Workerd runtime remain unqualified; nothing was deployed.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from WHO ICD-11 API and stays under the terms of that source: CC BY-ND 3.0 IGO; commercial OK.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
