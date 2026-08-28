/**
 * Minimal ZIP reader — locate one entry in an archive and inflate it.
 *
 * Workers has no unzip primitive, so this reads just enough of the format to
 * pull a single member out of WHO's release archives: End Of Central Directory
 * → central directory → local file header → `DecompressionStream("deflate-raw")`.
 * Stored (method 0) and deflate (method 8) entries only; no ZIP64, no encryption.
 *
 * The archive is read through a `ByteRangeSource` so the caller can serve the
 * bytes from HTTP range requests (~1.1 MB for the member we want) instead of
 * downloading all 4.2 MB.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;
const MAX_LOCAL_EXTRA = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

/** Random-access view over the archive bytes. */
export interface ByteRangeSource {
    /** Total archive size in bytes. */
    size: number;
    /** Read `[start, endExclusive)`. May return fewer bytes only at EOF. */
    read(start: number, endExclusive: number): Promise<Uint8Array>;
}

export interface ZipEntry {
    name: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Find the End Of Central Directory record and return the central-directory span. */
async function readEndOfCentralDirectory(
    source: ByteRangeSource,
): Promise<{ offset: number; size: number }> {
    const tailLength = Math.min(source.size, EOCD_MIN_SIZE + MAX_ZIP_COMMENT);
    const tailStart = source.size - tailLength;
    const tail = await source.read(tailStart, source.size);
    const dv = view(tail);

    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
        if (dv.getUint32(i, true) !== EOCD_SIGNATURE) continue;
        const size = dv.getUint32(i + 12, true);
        const offset = dv.getUint32(i + 16, true);
        if (offset === ZIP64_SENTINEL || size === ZIP64_SENTINEL) {
            throw new Error("ZIP64 archives are not supported");
        }
        return { offset, size };
    }
    throw new Error("Not a ZIP archive: no End Of Central Directory record found");
}

/** Locate one entry by exact name in the central directory. */
export async function findZipEntry(
    source: ByteRangeSource,
    name: string,
): Promise<ZipEntry> {
    const { offset, size } = await readEndOfCentralDirectory(source);
    const directory = await source.read(offset, offset + size);
    const dv = view(directory);
    const decoder = new TextDecoder();

    let cursor = 0;
    while (cursor + 46 <= directory.length) {
        if (dv.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) break;
        const compressionMethod = dv.getUint16(cursor + 10, true);
        const compressedSize = dv.getUint32(cursor + 20, true);
        const uncompressedSize = dv.getUint32(cursor + 24, true);
        const nameLength = dv.getUint16(cursor + 28, true);
        const extraLength = dv.getUint16(cursor + 30, true);
        const commentLength = dv.getUint16(cursor + 32, true);
        const localHeaderOffset = dv.getUint32(cursor + 42, true);
        const entryName = decoder.decode(
            directory.subarray(cursor + 46, cursor + 46 + nameLength),
        );

        if (entryName === name) {
            if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
                throw new Error(`ZIP64 entry is not supported: ${name}`);
            }
            return {
                name: entryName,
                compressionMethod,
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
            };
        }
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`ZIP entry not found: ${name}`);
}

/**
 * Read and decompress one entry. Returns the raw member bytes as a stream so a
 * caller can parse an 11 MB text member without ever holding it whole.
 */
export async function openZipEntry(
    source: ByteRangeSource,
    entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
    // The local header repeats the name and carries its own extra field, whose
    // length we cannot know in advance — over-read by the field's maximum and
    // then take exactly `compressedSize` bytes from the real data offset.
    const start = entry.localHeaderOffset;
    const end = Math.min(source.size, start + 30 + MAX_LOCAL_EXTRA + entry.compressedSize);
    const block = await source.read(start, end);
    const dv = view(block);

    if (dv.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`Corrupt ZIP: no local file header at offset ${start}`);
    }
    const nameLength = dv.getUint16(26, true);
    const extraLength = dv.getUint16(28, true);
    const dataStart = 30 + nameLength + extraLength;
    const compressed = block.subarray(dataStart, dataStart + entry.compressedSize);
    if (compressed.length < entry.compressedSize) {
        throw new Error(
            `Corrupt ZIP: entry ${entry.name} is truncated (${compressed.length} of ${entry.compressedSize} bytes)`,
        );
    }

    const body = new Blob([compressed]).stream();
    if (entry.compressionMethod === 0) return body;
    if (entry.compressionMethod === 8) {
        return body.pipeThrough(new DecompressionStream("deflate-raw"));
    }
    throw new Error(
        `Unsupported ZIP compression method ${entry.compressionMethod} for entry ${entry.name}`,
    );
}

/**
 * Byte source backed by HTTP range requests, falling back to a single full GET
 * when the origin ignores `Range` (it then serves slices from the held buffer).
 */
export async function createHttpByteRangeSource(url: string): Promise<ByteRangeSource> {
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (!probe.ok) {
        throw new Error(`Fetch failed (${probe.status}) for ${url}`);
    }

    const contentRange = probe.headers.get("content-range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : Number.NaN;
    if (probe.status === 206 && Number.isFinite(total) && total > 0) {
        await probe.arrayBuffer(); // drain the 1-byte probe body
        return {
            size: total,
            async read(start, endExclusive) {
                const response = await fetch(url, {
                    headers: { Range: `bytes=${start}-${endExclusive - 1}` },
                });
                if (!response.ok) {
                    throw new Error(`Range request failed (${response.status}) for ${url}`);
                }
                return new Uint8Array(await response.arrayBuffer());
            },
        };
    }

    // Origin ignored Range: a 200 answer to a range request carries the whole file.
    const whole = new Uint8Array(await probe.arrayBuffer());
    return {
        size: whole.length,
        async read(start, endExclusive) {
            return whole.subarray(start, endExclusive);
        },
    };
}
