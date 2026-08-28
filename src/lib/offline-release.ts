/**
 * Keyless tier — WHO's published ICD-11 MMS release file.
 *
 * `https://icdcdn.who.int/static/releasefiles/<release>/SimpleTabulation-ICD-11-MMS-en.zip`
 * is WHO first-party, needs no registration, and carries the whole linearization
 * (37k rows: code, title, class kind, chapter, groupings, parent). We download it
 * once, parse it, and serve a synthetic REST surface over the cached rows — the
 * same bulk-ingest pattern as fda-purple-book and europepmc.
 *
 * It is NOT the id.who.int API and must never be presented as such: the release
 * file has no definitions, no synonyms, no inclusion/exclusion notes, no
 * foundation search, no /autocode, no postcoordination and no DORIS, and it is a
 * yearly snapshot rather than the live classification. Callers stamp every
 * response with that limitation (see api-adapter.ts).
 *
 * Memory: the cache keeps one raw record string per row (plus a title, code and
 * entity index) and splits a row into fields only when a query actually returns
 * it. Measured on the real 2026-01 file by parsing it in Node 22 under
 * `--expose-gc --max-old-space-size=128` and reading heapUsed after two forced
 * GCs: 38.1 MB in the shipped row-string form,
 * 73.3 MB holding all 703,988 cells, 63.4 MB holding all 37,052 records as
 * objects. None of the three OOMs at a 128 MB heap cap, so the lazy split buys
 * headroom inside a Worker isolate's ~128 MB budget rather than making the
 * difference between working and not.
 */

import { createHttpByteRangeSource, findZipEntry, openZipEntry } from "./zip";

const RELEASE_FILE_BASE = "https://icdcdn.who.int/static/releasefiles";
const RELEASE_ENTRY = "SimpleTabulation-ICD-11-MMS-en.txt";
const DELIMITER_CODE = 9; // tab
const QUOTE_CODE = 34;

/** WHO's newest published MMS release file (SupportedClassifications lists 2026-01). */
export const DEFAULT_RELEASE = "2026-01";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Raw header → the column name we expose. Unknown headers fall back to snake_case. */
const COLUMN_NAMES: Record<string, string> = {
    "foundation uri": "foundation_uri",
    "linearization uri": "linearization_uri",
    code: "code",
    blockid: "block_id",
    title: "title",
    classkind: "class_kind",
    depthinkind: "depth_in_kind",
    isresidual: "is_residual",
    chapterno: "chapter_no",
    browserlink: "browser_link",
    isleaf: "is_leaf",
    "primary tabulation": "primary_tabulation",
    grouping1: "grouping1",
    grouping2: "grouping2",
    grouping3: "grouping3",
    grouping4: "grouping4",
    grouping5: "grouping5",
    codingnote: "coding_note",
    parent: "parent_uri",
};

const BOOLEAN_COLUMNS = new Set(["is_residual", "is_leaf", "primary_tabulation"]);

export interface Icd11Release {
    /** Release identifier as published by WHO, e.g. "2026-01". */
    release: string;
    /** The exact archive this data came from. */
    sourceUrl: string;
    /** WHO's own build stamp from the last header cell (e.g. "2026 Jan 17 - 05:30 UTC"). */
    versionStamp: string;
    columns: string[];
    /** One raw (still delimited) record per row; split on demand. */
    lines: string[];
    /** Lower-cased titles, parallel to `lines` — the text-search index. */
    titlesLower: string[];
    /** Upper-cased ICD-11 code → row index. */
    byCode: Map<string, number>;
    /** Foundation entity id → row index. */
    byEntity: Map<string, number>;
    fetchedAt: number;
}

export function releaseUrl(release: string): string {
    return `${RELEASE_FILE_BASE}/${release}/SimpleTabulation-ICD-11-MMS-en.zip`;
}

function columnName(header: string): string {
    const key = header.trim().toLowerCase();
    const mapped = COLUMN_NAMES[key];
    if (mapped) return mapped;
    return key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Foundation URIs end in the numeric entity id. */
export function entityIdFromUri(uri: string): string {
    const trimmed = uri.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    const segments = trimmed.split("/");
    return segments[segments.length - 1];
}

/** Titles are indented with "- " markers that repeat DepthInKind. */
export function cleanTitle(raw: string): string {
    return raw.replace(/^(?:-\s+)+/, "").trim();
}

// ── Record splitting ─────────────────────────────────────────────────────
//
// Two traps a naive `split("\n")` falls into on this file: records end with
// CRLF while CodingNote carries BARE LF characters inside the field, and quoted
// fields (Title, BrowserLink) double their inner quotes. So: a chunk-fed
// splitter that tracks quote state, auto-detects the record terminator from the
// header line, and survives a record straddling two stream chunks.
//
// Measured on the real 2026-01 file (11,661,691 bytes; byte counts, no parser):
// 37,153 LF of which 37,053 are CRLF, so 100 bare LFs spread over 50 records.
// Splitting on LF yields 37,152 rows; splitting on CRLF yields the correct
// 37,052.

export interface RecordSplitter {
    push(chunk: string): void;
    end(): void;
}

export function createRecordSplitter(onRecord: (line: string) => void): RecordSplitter {
    let carry = "";
    let inQuotes = false;
    let pendingQuote = false;
    let prevWasCr = false;
    let atStart = true;
    /** null until the header line reveals whether records end with CRLF or LF. */
    let crlfRecords: boolean | null = null;

    const emit = (text: string) => {
        const line = crlfRecords && text.endsWith("\r") ? text.slice(0, -1) : text;
        if (line !== "") onRecord(line);
    };

    return {
        push(chunk: string) {
            let text = chunk;
            if (atStart) {
                atStart = false;
                if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
            }
            if (crlfRecords === null) {
                const nl = text.indexOf("\n");
                if (nl >= 0) crlfRecords = nl > 0 && text.charCodeAt(nl - 1) === 13;
            }

            let start = 0;
            for (let i = 0; i < text.length; i++) {
                const code = text.charCodeAt(i);
                if (pendingQuote) {
                    pendingQuote = false;
                    if (code === QUOTE_CODE) continue; // "" — an escaped quote
                    inQuotes = false; // the quote closed the field
                }
                if (code === QUOTE_CODE) {
                    if (inQuotes) pendingQuote = true;
                    else inQuotes = true;
                    continue;
                }
                if (inQuotes) continue;
                if (code === 13) {
                    prevWasCr = true;
                    continue;
                }
                if (code === 10) {
                    const terminates = crlfRecords === false ? true : prevWasCr;
                    prevWasCr = false;
                    if (!terminates) continue; // bare LF inside a CRLF file is content
                    emit(carry + text.slice(start, i));
                    carry = "";
                    start = i + 1;
                    continue;
                }
                prevWasCr = false;
            }
            carry += text.slice(start);
        },
        end() {
            if (carry !== "") {
                emit(carry);
                carry = "";
            }
        },
    };
}

/** Split one raw record into its fields (quote aware, doubled quotes unescaped). */
export function splitCells(line: string, delimiterCode = DELIMITER_CODE): string[] {
    const cells: string[] = [];
    let field = "";
    let i = 0;
    let inQuotes = false;
    while (i < line.length) {
        const code = line.charCodeAt(i);
        if (inQuotes) {
            if (code === QUOTE_CODE) {
                if (line.charCodeAt(i + 1) === QUOTE_CODE) {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            let j = i;
            while (j < line.length && line.charCodeAt(j) !== QUOTE_CODE) j++;
            field += line.slice(i, j);
            i = j;
            continue;
        }
        if (code === QUOTE_CODE && field === "") {
            inQuotes = true;
            i++;
            continue;
        }
        if (code === delimiterCode) {
            cells.push(field);
            field = "";
            i++;
            continue;
        }
        let j = i;
        while (j < line.length) {
            const c = line.charCodeAt(j);
            if (c === delimiterCode || c === QUOTE_CODE) break;
            j++;
        }
        field += line.slice(i, j === i ? i + 1 : j);
        i = j === i ? i + 1 : j;
    }
    cells.push(field);
    return cells;
}

/** Build the cached release from the header line and the raw record lines. */
function buildRelease(
    release: string,
    sourceUrl: string,
    headerLine: string,
    lines: string[],
): Icd11Release {
    // WHO stamps the build into a trailing header cell ("Version:2026 Jan 17 - …")
    // that has no data column beneath it.
    const headerCells = splitCells(headerLine);
    let versionStamp = "";
    const last = headerCells[headerCells.length - 1] ?? "";
    if (/^version:/i.test(last.trim())) {
        versionStamp = last.trim().replace(/^version:\s*/i, "");
        headerCells.pop();
    }
    const columns = headerCells.map(columnName);

    const codeIdx = columns.indexOf("code");
    const titleIdx = columns.indexOf("title");
    const foundationIdx = columns.indexOf("foundation_uri");
    if (codeIdx === -1 || titleIdx === -1 || foundationIdx === -1) {
        throw new Error(
            `Unexpected ICD-11 tabulation header (columns: ${columns.join(", ") || "none"})`,
        );
    }

    const titlesLower: string[] = new Array(lines.length);
    const byCode = new Map<string, number>();
    const byEntity = new Map<string, number>();

    for (let i = 0; i < lines.length; i++) {
        const cells = splitCells(lines[i]);
        titlesLower[i] = cleanTitle(cells[titleIdx] ?? "").toLowerCase();
        const code = (cells[codeIdx] ?? "").trim().toUpperCase();
        if (code && !byCode.has(code)) byCode.set(code, i);
        const entity = entityIdFromUri(cells[foundationIdx] ?? "");
        if (entity && !byEntity.has(entity)) byEntity.set(entity, i);
    }

    return {
        release,
        sourceUrl,
        versionStamp,
        columns,
        lines,
        titlesLower,
        byCode,
        byEntity,
        fetchedAt: Date.now(),
    };
}

function collectLines(): {
    onRecord: (line: string) => void;
    finish: (release: string, sourceUrl: string) => Icd11Release;
} {
    let headerLine: string | null = null;
    const lines: string[] = [];
    return {
        onRecord(line) {
            if (headerLine === null) headerLine = line;
            else lines.push(line);
        },
        finish(release, sourceUrl) {
            if (headerLine === null) throw new Error("Empty ICD-11 tabulation file");
            return buildRelease(release, sourceUrl, headerLine, lines);
        },
    };
}

/** Parse an already-materialized tabulation file (used by the tests). */
export function parseTabulationText(
    release: string,
    sourceUrl: string,
    text: string,
): Icd11Release {
    const collector = collectLines();
    const splitter = createRecordSplitter(collector.onRecord);
    splitter.push(text);
    splitter.end();
    return collector.finish(release, sourceUrl);
}

/**
 * Download + parse one release. The 11.6 MB member is inflated and split as a
 * stream so the whole text never sits in memory as one string.
 */
export async function fetchRelease(release: string): Promise<Icd11Release> {
    const url = releaseUrl(release);
    const source = await createHttpByteRangeSource(url);
    const entry = await findZipEntry(source, RELEASE_ENTRY);
    const stream = await openZipEntry(source, entry);

    const collector = collectLines();
    const splitter = createRecordSplitter(collector.onRecord);
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(value);
    }
    splitter.end();
    return collector.finish(release, url);
}

// ── Cache (one release per isolate; switching release evicts) ────────────

let cached: Icd11Release | null = null;
let inflight: Promise<Icd11Release> | null = null;
let inflightRelease = "";

export function resetReleaseCache(): void {
    cached = null;
    inflight = null;
    inflightRelease = "";
}

export async function loadRelease(release: string = DEFAULT_RELEASE): Promise<Icd11Release> {
    if (cached && cached.release === release && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached;
    }
    if (inflight && inflightRelease === release) return inflight;
    inflightRelease = release;
    inflight = fetchRelease(release)
        .then((loaded) => {
            cached = loaded;
            return loaded;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

// ── Row access ──────────────────────────────────────────────────────────

export type Icd11Record = Record<string, string | number | boolean | null>;

function toBool(raw: string): boolean | null {
    const value = raw.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
}

/** Raw fields of one row, in `rel.columns` order. */
export function releaseRow(rel: Icd11Release, index: number): string[] {
    return splitCells(rel.lines[index]);
}

/**
 * Materialize one row as a flat record — flat so a staged dataset becomes one
 * clean SQLite table. `title` is de-indented, BrowserLink's spreadsheet formula
 * is reduced to its URL, and the entity ids are lifted out of the URIs.
 */
export function releaseRecord(rel: Icd11Release, index: number): Icd11Record {
    const cells = releaseRow(rel, index);
    const record: Icd11Record = {};
    for (let c = 0; c < rel.columns.length; c++) {
        const name = rel.columns[c];
        const raw = (cells[c] ?? "").trim();
        if (name === "title") {
            record.title = cleanTitle(raw);
        } else if (name === "browser_link") {
            const url = raw.match(/https?:\/\/[^"]+/);
            record.browser_link = url ? url[0] : raw;
        } else if (BOOLEAN_COLUMNS.has(name)) {
            record[name] = toBool(raw);
        } else if (name === "depth_in_kind") {
            record.depth_in_kind = raw === "" ? null : Number(raw);
        } else {
            record[name] = raw;
        }
    }
    record.entity_id = entityIdFromUri(String(record.foundation_uri ?? ""));
    record.parent_entity_id = entityIdFromUri(String(record.parent_uri ?? ""));
    return record;
}

export function releaseRecords(rel: Icd11Release, indexes: number[]): Icd11Record[] {
    return indexes.map((index) => releaseRecord(rel, index));
}
