/**
 * Behaviour gates for the ICD-11 keyless tier.
 *
 * These lock in the two things a reviewer must be able to trust:
 *   1. A missing WHO credential FAILS a gated call — it is never answered from
 *      the release file and never dressed up as a success.
 *   2. Keyless answers name their own source (icdcdn.who.int / NLM), never
 *      id.who.int, and carry an explicit degraded flag.
 * Plus the release-file parser traps that silently corrupt rows.
 *
 * Run: npx tsx --test test/keyless-tier.mts
 */

import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import adapterModule from "../src/lib/api-adapter.ts";
import releaseModule from "../src/lib/offline-release.ts";

// tsx loads these .ts modules as CommonJS (the package has no "type": "module"),
// so the named exports arrive on the default binding.
const { createIcd11ApiFetch, hasLiveCredentials } = adapterModule as any;
const { parseTabulationText, splitCells } = releaseModule as any;

const NL = "\r\n";

/**
 * Real 2026-01 header and rows, trimmed to four records. The last one carries
 * the bare LF inside CodingNote that shreds a naive line split.
 */
const HEADER = [
    "Foundation URI", "Linearization URI", "Code", "BlockId", "Title", "ClassKind",
    "DepthInKind", "IsResidual", "ChapterNo", "BrowserLink", "isLeaf", "Primary tabulation",
    "Grouping1", "Grouping2", "Grouping3", "Grouping4", "Grouping5", "CodingNote", "Parent",
    "Version:2026 Jan 17 - 05:30 UTC",
].join("\t");

const ROWS = [
    [
        "http://id.who.int/icd/entity/1435254666",
        "http://id.who.int/icd/release/11/mms/1435254666",
        "", "", '"Certain infectious or parasitic diseases"', "chapter", "1", "False", "01",
        '"=hyperlink(""https://icd.who.int/browse/latestrelease/mms/en#1435254666"",""browser"")"',
        "False", "", "", "", "", "", "", "", "",
    ].join("\t"),
    [
        "http://id.who.int/icd/entity/1600014919",
        "http://id.who.int/icd/release/11/mms/1600014919",
        "1C1G", "", '"- - Lyme borreliosis"', "category", "1", "False", "01",
        '"=hyperlink(""https://icd.who.int/browse/latestrelease/mms/en#1600014919"",""browser"")"',
        "False", "True", "BlockL1-1C1", "", "", "", "",
        "Use additional code if desired, to identify any associated condition.\n\nUse additional code, if desired, to identify any sequelae.",
        "http://id.who.int/icd/entity/1435254666",
    ].join("\t"),
    [
        "http://id.who.int/icd/entity/465177735",
        "http://id.who.int/icd/release/11/mms/465177735",
        "5A1Y", "", '"- - Diabetes mellitus"', "category", "1", "False", "05",
        '"=hyperlink(""https://icd.who.int/browse/latestrelease/mms/en#465177735"",""browser"")"',
        "False", "True", "BlockL1-5A0", "", "", "", "", "", "",
    ].join("\t"),
    [
        "http://id.who.int/icd/entity/119724091",
        "http://id.who.int/icd/release/11/mms/119724091",
        "5A11", "", '"- - - Type 2 diabetes mellitus"', "category", "1", "False", "05",
        '"=hyperlink(""https://icd.who.int/browse/latestrelease/mms/en#119724091"",""browser"")"',
        "True", "True", "BlockL1-5A0", "BlockL2-5A1", "", "", "", "",
        "http://id.who.int/icd/entity/465177735",
    ].join("\t"),
];

const FIXTURE = "\uFEFF" + [HEADER, ...ROWS].join(NL) + NL;
const SOURCE_URL =
    "https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip";

function fixtureRelease() {
    return parseTabulationText("2026-01", SOURCE_URL, FIXTURE);
}

function keylessFetch() {
    const release = fixtureRelease();
    return createIcd11ApiFetch(
        {},
        {
            loadRelease: async () => release,
            nlmSearch: async () => {
                throw new Error("nlmSearch must not be called by these cases");
            },
        },
    );
}

// ── Parser ───────────────────────────────────────────────────────────────

test("release parser keeps CRLF records whole when a field holds a bare LF", () => {
    const rel = fixtureRelease();
    assert.equal(rel.lines.length, 4, "a bare LF inside CodingNote must not split a record");
    assert.equal(rel.versionStamp, "2026 Jan 17 - 05:30 UTC");
    assert.equal(rel.columns.length, 19, "the Version stamp cell is not a data column");
});

test("release parser unwraps quotes, doubled quotes and title indentation", () => {
    const rel = fixtureRelease();
    const index = rel.byCode.get("5A11");
    assert.notEqual(index, undefined);
    const record = releaseRecordOf(rel, index);
    assert.equal(record.title, "Type 2 diabetes mellitus");
    assert.equal(record.entity_id, "119724091");
    assert.equal(record.parent_entity_id, "465177735");
    assert.equal(
        record.browser_link,
        "https://icd.who.int/browse/latestrelease/mms/en#119724091",
    );
    assert.equal(record.is_leaf, true);
    assert.equal(record.depth_in_kind, 1);
});

function releaseRecordOf(rel: any, index: number) {
    return (releaseModule as any).releaseRecord(rel, index);
}

test("splitCells unescapes a doubled quote inside a quoted field", () => {
    const cells = splitCells('a\t"say ""hi"" now"\tb');
    assert.deepEqual(cells, ["a", 'say "hi" now', "b"]);
});

// ── Credential gating ────────────────────────────────────────────────────

test("hasLiveCredentials needs both halves", () => {
    assert.equal(hasLiveCredentials({}), false);
    assert.equal(hasLiveCredentials({ ICD11_CLIENT_ID: "x" }), false);
    assert.equal(hasLiveCredentials({ ICD11_CLIENT_ID: "x", ICD11_CLIENT_SECRET: "y" }), true);
});

test("a gated path without a credential FAILS and points at the keyless tier", async () => {
    const api = keylessFetch();
    await assert.rejects(
        () => api({ method: "GET", path: "/entity/119724091" }),
        (error: Error) => {
            assert.match(error.message, /ICD11_CLIENT_ID/);
            assert.match(error.message, /icd\.who\.int\/icdapi\/Account\/Register/);
            assert.match(error.message, /\/offline\/mms\/search/);
            return true;
        },
        "a missing credential must surface as an error, never as offline data",
    );
});

test("a gated linearization path without a credential FAILS too", async () => {
    const api = keylessFetch();
    await assert.rejects(() => api({ method: "GET", path: "/release/11/mms/5A11" }));
});

// ── Keyless answers ──────────────────────────────────────────────────────

test("keyless code lookup answers from WHO's release file and says so", async () => {
    const api = keylessFetch();
    const result: any = await api({ method: "GET", path: "/offline/mms/code/5a11" });
    assert.equal(result.status, 200);
    assert.equal(result.data.tier, "keyless_offline");
    assert.equal(result.data.degraded, true);
    assert.equal(result.data.found, true);
    assert.equal(result.data.record.title, "Type 2 diabetes mellitus");
    assert.equal(result.data.provenance.source, "icdcdn.who.int");
    assert.equal(result.data.provenance.source_url, SOURCE_URL);
    assert.match(result.data.provenance.not_from, /id\.who\.int/);
    assert.ok(
        result.data.provenance.not_available_in_this_tier.some((gap: string) =>
            /definition/.test(gap),
        ),
        "the tier must state that definitions are missing",
    );
    assert.deepEqual(
        result.data.ancestors.map((a: any) => a.title),
        ["Diabetes mellitus"],
    );
});

test("keyless search ranks the exact title first and filters by class kind", async () => {
    const api = keylessFetch();
    const result: any = await api({
        method: "GET",
        path: "/offline/mms/search",
        params: { q: "diabetes", class_kind: "category" },
    });
    assert.equal(result.data.total_matched, 2);
    assert.equal(result.data.results[0].title, "Diabetes mellitus");
    assert.equal(result.data.tier, "keyless_offline");
});

test("a code that is absent reports found:false rather than inventing a record", async () => {
    const api = keylessFetch();
    const result: any = await api({ method: "GET", path: "/offline/mms/code/ZZ99" });
    assert.equal(result.data.found, false);
    assert.equal(result.data.record, null);
});

test("keyless children resolve through the Parent column", async () => {
    const api = keylessFetch();
    const result: any = await api({ method: "GET", path: "/offline/mms/children/1435254666" });
    assert.equal(result.data.total_matched, 1);
    assert.equal(result.data.results[0].code, "1C1G");
});

test("an unknown filter column is rejected instead of silently ignored", async () => {
    const api = keylessFetch();
    await assert.rejects(
        () => api({ method: "GET", path: "/offline/mms/rows", params: { nosuch: "x" } }),
        /Unknown filter column/,
    );
});

test("an unusable release identifier is rejected", async () => {
    const api = keylessFetch();
    await assert.rejects(
        () => api({ method: "GET", path: "/offline/status", params: { release: "latest" } }),
        /Invalid release/,
    );
});

// ── Advertised surface must be the real surface ──────────────────────────

test("a mistyped search filter is rejected, not silently dropped", async () => {
    const api = keylessFetch();
    const correct: any = await api({
        method: "GET",
        path: "/offline/mms/search",
        params: { q: "diabetes", class_kind: "category" },
    });
    assert.equal(correct.data.total_matched, 2);
    await assert.rejects(
        () =>
            api({
                method: "GET",
                path: "/offline/mms/search",
                params: { q: "diabetes", class_knd: "category" },
            }),
        (error: Error) => {
            assert.match(error.message, /Unknown parameter 'class_knd'/);
            assert.match(error.message, /class_kind/);
            return true;
        },
        "a typo'd filter must fail loudly instead of returning the unfiltered hit set",
    );
});

test("every /offline/* endpoint rejects a parameter it does not know", async () => {
    const api = keylessFetch();
    for (const path of [
        "/offline/status",
        "/offline/mms/code/5A11",
        "/offline/mms/entity/119724091",
        "/offline/mms/children/1435254666",
    ]) {
        await assert.rejects(
            () => api({ method: "GET", path, params: { nosuch: "x" } }),
            /Unknown parameter 'nosuch'/,
            `${path} must reject an unknown parameter`,
        );
    }
});

test("/offline/status advertises only filters that /offline/mms/rows accepts", async () => {
    const api = keylessFetch();
    const status: any = await api({ method: "GET", path: "/offline/status" });
    assert.deepEqual(status.data.derived_columns, ["entity_id", "parent_entity_id"]);
    assert.equal(status.data.columns.includes("entity_id"), false, "entity_id is derived, not a file column");
    assert.deepEqual(
        status.data.filterable_columns,
        status.data.columns.concat(status.data.derived_columns),
    );
    for (const column of status.data.filterable_columns) {
        const rows: any = await api({
            method: "GET",
            path: "/offline/mms/rows",
            params: { [column]: "zzz-no-such-value" },
        });
        assert.equal(rows.data.total_matched, 0, `${column} must be a usable filter`);
    }
});

test("the derived entity ids filter rows by exact id", async () => {
    const api = keylessFetch();
    const one: any = await api({
        method: "GET",
        path: "/offline/mms/rows",
        params: { entity_id: "119724091" },
    });
    assert.equal(one.data.total_matched, 1);
    assert.equal(one.data.results[0].code, "5A11");

    const children: any = await api({
        method: "GET",
        path: "/offline/mms/rows",
        params: { parent_entity_id: "465177735" },
    });
    assert.equal(children.data.total_matched, 1);
    assert.equal(children.data.results[0].title, "Type 2 diabetes mellitus");

    // Exact, not substring: a prefix of a real id must match nothing.
    const prefix: any = await api({
        method: "GET",
        path: "/offline/mms/rows",
        params: { entity_id: "1197240" },
    });
    assert.equal(prefix.data.total_matched, 0);
});

test("the catalog's own entityId spelling is accepted as a query param", async () => {
    const api = keylessFetch();
    for (const params of [{ entity_id: "119724091" }, { entityId: "119724091" }]) {
        const result: any = await api({ method: "GET", path: "/offline/mms/entity", params });
        assert.equal(result.data.found, true);
        assert.equal(result.data.record.code, "5A11");
    }
});

// ── Citation source descriptor ───────────────────────────────────────────

/**
 * `src/tools/code-mode.ts` reaches the shared execute-tool factory, which
 * requires `cloudflare:workers`. Node cannot resolve that specifier, so stub it
 * for the load — nothing under test calls into the stub.
 */
const nodeLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === "cloudflare:workers") {
        return {
            DurableObject: class {},
            WorkerEntrypoint: class {},
            RpcTarget: class {},
            env: {},
        };
    }
    return nodeLoad.call(this, request, ...rest);
};

const codeMode = (await import("../src/tools/code-mode.ts")) as any;

/**
 * Register the Code Mode tools with the execute-tool factory replaced by a
 * capture, and hand back the options this server really passed it. The citation
 * source is not readable from the object the factory returns, so this is the
 * only way to gate what a result is actually signed with.
 */
function capturedExecuteOptions(env: Record<string, unknown>): any {
    const registered: string[] = [];
    const server = {
        tool: (name: string) => {
            registered.push(name);
        },
    };
    let captured: any;
    codeMode.registerCodeMode(server, env, {
        createExecuteTool: (options: any) => {
            captured = options;
            return { register: (s: any) => s.tool("icd11_execute") };
        },
    });
    assert.deepEqual(registered, ["icd11_search", "icd11_execute"]);
    assert.ok(captured, "registerCodeMode must build the execute tool");
    return captured;
}

test("a keyless result is signed with the keyless TIER, not one of its upstreams", () => {
    const options = capturedExecuteOptions({});
    assert.equal(options.source.id, "icd11-keyless");
    assert.deepEqual(options.source, codeMode.ICD11_KEYLESS_SOURCE);

    // The tier has TWO upstreams and the citation is issued once per program,
    // so naming either one alone would be false of the other one's bytes.
    assert.match(options.source.name, /icdcdn\.who\.int/);
    assert.match(options.source.name, /clinicaltables\.nlm\.nih\.gov/);
    assert.match(options.source.name, /no byte here came from the gated id\.who\.int/);
    assert.equal(
        options.source.url,
        undefined,
        "no single url is true of both keyless upstreams",
    );
    // A release is chosen per call, so a program-level version claim would be
    // false for any program that asked for another one. The per-call release and
    // WHO build stamp stay in the payload's provenance block.
    assert.equal(options.source.version, undefined);
});

test("a credentialed deployment is signed with a different source id", () => {
    const options = capturedExecuteOptions({
        ICD11_CLIENT_ID: "id",
        ICD11_CLIENT_SECRET: "secret",
    });
    assert.equal(options.source.id, "icd11-credentialed");
    assert.deepEqual(options.source, codeMode.ICD11_CREDENTIALED_SOURCE);
    assert.match(options.source.name, /id\.who\.int/);
    // The credential does not close the keyless paths, so those upstreams stay
    // in the descriptor too.
    assert.match(options.source.name, /icdcdn\.who\.int/);
    assert.match(options.source.name, /clinicaltables\.nlm\.nih\.gov/);
    assert.notEqual(
        codeMode.ICD11_KEYLESS_SOURCE.id,
        codeMode.ICD11_CREDENTIALED_SOURCE.id,
        "the two tiers must be distinguishable from the citation alone",
    );
});

test("icd11Source follows the credential state, not a literal", () => {
    assert.deepEqual(codeMode.icd11Source(false), codeMode.ICD11_KEYLESS_SOURCE);
    assert.deepEqual(codeMode.icd11Source(true), codeMode.ICD11_CREDENTIALED_SOURCE);
});
