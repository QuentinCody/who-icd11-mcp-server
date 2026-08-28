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

- `icd11_search` — discover available API operations (Code Mode catalog search, 16 endpoints across both tiers)
- `icd11_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `icd11_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `icd11_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

## Two tiers: gated WHO API, keyless release file

WHO's ICD-11 API is registration-gated. This server therefore serves two clearly separated tiers, on paths that cannot be mistaken for one another.

| | Gated tier | Keyless tier |
|---|---|---|
| Paths | `/entity*`, `/release/11/*` | `/offline/*` |
| Upstream | `https://id.who.int/icd` | `https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip` (WHO) and `https://clinicaltables.nlm.nih.gov/api/icd11_codes/v3/search` (NLM/NIH mirror) |
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
