// A ZIP container, writer and reader, in as little code as the format allows.
//
// There is no compressor here: the browser has one. ZIP's method 8 stores a raw
// deflate stream, which is exactly what CompressionStream('deflate-raw') emits,
// so all that is left is the container - a header before each file, a directory
// at the end, and a record pointing at that directory. Where the streams are
// missing the entries are stored uncompressed, which every unzipper reads.
//
// Everything is little-endian, and nothing here is large enough to need zip64.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// bit 11: the file name is UTF-8. Without it a Korean name arrives as mojibake,
// since the format's default is a DOS code page.
const FLAG_UTF8 = 0x0800;

const STORED = 0;
const DEFLATED = 8;

type ZipEntry = { name: string, data: Uint8Array };

let crcTable: Uint32Array | null = null;

const crc32 = (bytes: Uint8Array) => {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; ++i) {
            let c = i;
            for (let k = 0; k < 8; ++k) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; ++i) {
        crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

// MS-DOS packed date and time, which is what the format records
const dosStamp = (date: Date) => ({
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
});

const pipe = async (bytes: Uint8Array, transform: { readable: ReadableStream, writable: WritableStream }) => {
    const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(transform as any);
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

const deflateRaw = async (bytes: Uint8Array) => {
    if (typeof CompressionStream === 'undefined' || bytes.length === 0) {
        return null;
    }
    try {
        const out = await pipe(bytes, new CompressionStream('deflate-raw'));
        // a deflate stream that grew is not worth storing
        return out.length < bytes.length ? out : null;
    } catch (error) {
        return null;
    }
};

const inflateRaw = (bytes: Uint8Array) => {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('deflate is not supported by this browser');
    }
    return pipe(bytes, new DecompressionStream('deflate-raw'));
};

/**
 * Pack entries into a zip archive. Entries are deflated where the browser can,
 * and stored where it cannot.
 */
const zip = async (entries: ZipEntry[]): Promise<Blob> => {
    const encoder = new TextEncoder();
    const { time, date } = dosStamp(new Date());

    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const packed = await deflateRaw(entry.data);
        const body = packed ?? entry.data;
        const method = packed ? DEFLATED : STORED;

        const header = new DataView(new ArrayBuffer(30));
        header.setUint32(0, LOCAL_SIG, true);
        header.setUint16(4, 20, true);            // version needed
        header.setUint16(6, FLAG_UTF8, true);
        header.setUint16(8, method, true);
        header.setUint16(10, time, true);
        header.setUint16(12, date, true);
        header.setUint32(14, crc, true);
        header.setUint32(18, body.length, true);
        header.setUint32(22, entry.data.length, true);
        header.setUint16(26, name.length, true);
        header.setUint16(28, 0, true);            // no extra field

        parts.push(header.buffer, name.slice().buffer, body.slice().buffer);

        const record = new DataView(new ArrayBuffer(46 + name.length));
        record.setUint32(0, CENTRAL_SIG, true);
        record.setUint16(4, 20, true);            // version made by
        record.setUint16(6, 20, true);            // version needed
        record.setUint16(8, FLAG_UTF8, true);
        record.setUint16(10, method, true);
        record.setUint16(12, time, true);
        record.setUint16(14, date, true);
        record.setUint32(16, crc, true);
        record.setUint32(20, body.length, true);
        record.setUint32(24, entry.data.length, true);
        record.setUint16(28, name.length, true);
        record.setUint16(30, 0, true);            // extra
        record.setUint16(32, 0, true);            // comment
        record.setUint16(34, 0, true);            // disk
        record.setUint16(36, 0, true);            // internal attributes
        record.setUint32(38, 0, true);            // external attributes
        record.setUint32(42, offset, true);
        new Uint8Array(record.buffer).set(name, 46);
        central.push(new Uint8Array(record.buffer));

        offset += 30 + name.length + body.length;
    }

    const directorySize = central.reduce((sum, r) => sum + r.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, EOCD_SIG, true);
    end.setUint16(4, 0, true);                    // this disk
    end.setUint16(6, 0, true);                    // disk the directory starts on
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);                   // comment

    central.forEach(r => parts.push(r.slice().buffer));
    parts.push(end.buffer);

    return new Blob(parts, { type: 'application/zip' });
};

/**
 * Read an archive back. Directories and anything stored with a method this does
 * not know are skipped rather than failing the whole archive.
 */
const unzip = async (buffer: ArrayBuffer): Promise<ZipEntry[]> => {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const decoder = new TextDecoder();

    // the end record sits at the very end, behind a comment of unknown length
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; --i) {
        if (view.getUint32(i, true) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('not a zip archive');
    }

    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const entries: ZipEntry[] = [];

    for (let i = 0; i < count; ++i) {
        if (view.getUint32(at, true) !== CENTRAL_SIG) {
            break;
        }
        const method = view.getUint16(at + 10, true);
        const compressedSize = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localAt = view.getUint32(at + 42, true);
        const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;

        if (name.endsWith('/')) {
            continue;
        }

        // the local header repeats the name and extra lengths, and they are the
        // ones that say where the data starts
        const localNameLength = view.getUint16(localAt + 26, true);
        const localExtraLength = view.getUint16(localAt + 28, true);
        const start = localAt + 30 + localNameLength + localExtraLength;
        const raw = bytes.subarray(start, start + compressedSize);

        if (method === STORED) {
            entries.push({ name, data: raw.slice() });
        } else if (method === DEFLATED) {
            entries.push({ name, data: await inflateRaw(raw) });
        }
    }

    return entries;
};

export { zip, unzip };
export type { ZipEntry };
