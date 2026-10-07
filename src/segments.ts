import { Color } from 'playcanvas';

import { Events } from './events';
import { PermutedChunkSource } from './io';
import { Splat } from './splat';
import { State } from './splat-state';

// A gaussian carries at most one label per LAYER, and a document may hold any
// number of layers. Several layers therefore give one gaussian several parallel
// labels ("부재: 옥개석" + "손상: 균열A") without any containment relationship
// between them, and without a gaussian ever holding two conflicting values on
// the same axis.
//
// Inside a layer the labels form a TREE: every label may name a parent label in
// the same layer. Depth is unbounded, so a hierarchy is expressed by the parent
// chain rather than by inventing one layer per level. A gaussian is tagged with
// the deepest label that applies; its ancestors follow from the chain.
//
// Storage is one Int32Array per layer, indexed by SOURCE ROW (not instance
// index): instance indices shift when gaussians are deleted, source rows do not.

const PALETTE = [
    '#e6194b', '#4363d8', '#3cb44b', '#ffe119', '#f58231',
    '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#008080',
    '#e6beff', '#9a6324', '#fabebe', '#800000', '#aaffc3'
];

const DEFAULT_LAYER = 'default';

// '#rrggbb' -> engine Color, so the viewport highlight can take the colour the
// panel shows next to the label
const parseColor = (hex: string) => {
    const value = parseInt((hex ?? '').replace('#', ''), 16);
    if (!Number.isFinite(value)) {
        return null;
    }
    return new Color(
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255,
        1
    );
};

const NO_LABEL = -1;

type Segment = {
    id: number;
    name: string;
    layer: string;
    color: string;
    // parent label within the same layer; null for a root label
    parent: number | null;
};

type LabelHit = {
    layer: string;
    name: string;
    color: string;
    // label names from the root of the layer down to this one
    path: string[];
};

// The file format written by 'export' and accepted by 'import'.
//   version 1  { segments: [{id, name}],     labels: [3, -1, ...] }
//   version 2  { segments: [{id, partName}], labels: [3, -1, ...] }
//   version 3  { segments: [{id, name, layer}], labels: [[3], [3, 7], [], ...] }
//   version 4  { parts:    [{id, name, layer, parent}], labels: [[3], [3, 7], [], ...] }
// Versions 1 and 2 are read back into a single layer; 3 is read with parent = null.
const FILE_VERSION = 4;

// 주관사 「ROI 저작 정보」 format version carried in every exported file
const ROI_FORMAT_VERSION = '1.0';
const MODEL_VERSION = '1.0';

// The two big integer arrays are written beside the JSON as flat binary files:
// one gaussian's label is 2 bytes instead of the 3-7 characters JSON spends on
// it. In the array's place the JSON keeps the file's name and nothing else, as
// 주관사 asked, so the dtype below is fixed by agreement rather than recorded in
// the file - it belongs in the format document, not in a field.
//   labels            int16  little-endian, one per gaussian, -1 = no label
//   Gaussian_Indices  uint32 little-endian, one file per ROI, ascending
// Object_Indices stays inline: it is short and a reader wants to see it.
const LABEL_BYTES = 2;
const INDEX_BYTES = 4;

// typed arrays use the host's byte order; every mainstream platform is little
// endian, but a file format may not rest on that
const hostIsLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const toLittleEndian = (view: Int16Array | Uint32Array): ArrayBuffer => {
    const buffer = view.buffer as ArrayBuffer;
    if (hostIsLittleEndian) {
        return buffer;
    }
    const bytes = new Uint8Array(buffer);
    const width = view.BYTES_PER_ELEMENT;
    for (let i = 0; i < bytes.length; i += width) {
        for (let a = i, b = i + width - 1; a < b; ++a, --b) {
            const t = bytes[a]; bytes[a] = bytes[b]; bytes[b] = t;
        }
    }
    return buffer;
};

const fromLittleEndian = (buffer: ArrayBuffer, width: number): ArrayBuffer => {
    if (hostIsLittleEndian) {
        return buffer;
    }
    const bytes = new Uint8Array(buffer.slice(0));
    for (let i = 0; i < bytes.length; i += width) {
        for (let a = i, b = i + width - 1; a < b; ++a, --b) {
            const t = bytes[a]; bytes[a] = bytes[b]; bytes[b] = t;
        }
    }
    return bytes.buffer;
};

class SplatSegments {
    artifactName = '';
    artifactId = '';

    segments: Segment[] = [];
    layers: string[] = [];

    private rowsByLayer = new Map<string, Int32Array>();
    private nextId = 0;

    readonly numRows: number;

    // Deleting gaussians removes them from the instance list but leaves their
    // labels alone, so an undo can bring both back together. Everything that
    // reports or writes a label must therefore ask whether the row is still in
    // the scene. null means nothing has been deleted and every row is live.
    liveRows: Uint8Array | null = null;

    constructor(numRows: number) {
        this.numRows = numRows;
    }

    get empty() {
        return this.segments.length === 0;
    }

    rows(layer: string): Int32Array {
        let rows = this.rowsByLayer.get(layer);
        if (!rows) {
            rows = new Int32Array(this.numRows).fill(NO_LABEL);
            this.rowsByLayer.set(layer, rows);
            if (!this.layers.includes(layer)) {
                this.layers.push(layer);
            }
        }
        return rows;
    }

    hasLayer(layer: string) {
        return this.rowsByLayer.has(layer);
    }

    segmentById(id: number) {
        return this.segments.find(s => s.id === id) ?? null;
    }

    segmentsOfLayer(layer: string) {
        return this.segments.filter(s => s.layer === layer);
    }

    // A name is only unique among SIBLINGS: a pagoda repeats 갑석 and 탑신석 on
    // every tier, so the same name under a different parent is a different Object.
    findSegment(layer: string, name: string, parent: number | null = null) {
        return this.segments.find(s => s.layer === layer && s.name === name && s.parent === parent
        ) ?? null;
    }

    createSegment(layer: string, name: string, parent: number | null = null, color?: string) {
        const used = new Set(this.segments.map(s => s.color));
        // a parent must live in the same layer, otherwise the label becomes a root
        const parentSegment = parent === null ? null : this.segmentById(parent);
        const segment: Segment = {
            id: this.nextId++,
            name,
            layer,
            color: color ?? (PALETTE.find(c => !used.has(c)) ?? PALETTE[this.segments.length % PALETTE.length]),
            parent: (parentSegment && parentSegment.layer === layer) ? parentSegment.id : null
        };
        this.segments.push(segment);
        this.rows(layer);
        return segment;
    }

    // ---- tree ----------------------------------------------------------

    childrenOf(id: number | null) {
        return this.segments.filter(s => s.parent === id);
    }

    rootsOfLayer(layer: string) {
        return this.segments.filter(s => s.layer === layer && s.parent === null);
    }

    // this segment and everything below it
    descendantsOf(id: number): number[] {
        const out: number[] = [id];
        for (let i = 0; i < out.length; ++i) {
            this.childrenOf(out[i]).forEach(c => out.push(c.id));
        }
        return out;
    }

    // root -> ... -> this segment
    pathOf(id: number): Segment[] {
        const out: Segment[] = [];
        let cursor = this.segmentById(id);
        const guard = new Set<number>();
        while (cursor && !guard.has(cursor.id)) {
            guard.add(cursor.id);
            out.unshift(cursor);
            cursor = cursor.parent === null ? null : this.segmentById(cursor.parent);
        }
        return out;
    }

    depthOf(id: number) {
        return this.pathOf(id).length - 1;
    }

    // re-parent, refusing a move that would form a cycle or cross layers
    setParent(id: number, parent: number | null) {
        const segment = this.segmentById(id);
        if (!segment) {
            return false;
        }
        if (parent === null) {
            segment.parent = null;
            return true;
        }
        const target = this.segmentById(parent);
        if (!target || target.layer !== segment.layer || target.id === segment.id) {
            return false;
        }
        if (this.descendantsOf(id).includes(target.id)) {
            return false;
        }
        segment.parent = target.id;
        return true;
    }

    renameSegment(id: number, name: string) {
        const segment = this.segmentById(id);
        if (segment) {
            segment.name = name;
        }
    }

    // remove a segment and clear every row that pointed at it
    deleteSegment(id: number) {
        const segment = this.segmentById(id);
        if (!segment) {
            return;
        }
        const rows = this.rows(segment.layer);
        for (let i = 0; i < rows.length; ++i) {
            if (rows[i] === id) {
                rows[i] = NO_LABEL;
            }
        }
        // keep the tree connected: the children move up to the deleted parent
        this.childrenOf(id).forEach((c) => {
            c.parent = segment.parent;
        });
        this.segments = this.segments.filter(s => s.id !== id);

        // drop the layer once its last segment is gone
        if (this.segmentsOfLayer(segment.layer).length === 0) {
            this.rowsByLayer.delete(segment.layer);
            this.layers = this.layers.filter(l => l !== segment.layer);
        }
    }

    deleteLayer(layer: string) {
        this.segmentsOfLayer(layer).forEach((s) => {
            this.segments = this.segments.filter(x => x.id !== s.id);
        });
        this.rowsByLayer.delete(layer);
        this.layers = this.layers.filter(l => l !== layer);
    }

    countOf(id: number) {
        const segment = this.segmentById(id);
        if (!segment) {
            return 0;
        }
        const rows = this.rows(segment.layer);
        const live = this.liveRows;
        let count = 0;
        for (let i = 0; i < rows.length; ++i) {
            if (rows[i] === id && (!live || live[i] !== 0)) {
                count++;
            }
        }
        return count;
    }

    // every label a single source row carries, one per layer at most
    labelsOfRow(row: number): LabelHit[] {
        const result: LabelHit[] = [];
        this.layers.forEach((layer) => {
            const id = this.rows(layer)[row];
            if (id !== NO_LABEL) {
                const segment = this.segmentById(id);
                if (segment) {
                    result.push({
                        layer,
                        name: segment.name,
                        color: segment.color,
                        path: this.pathOf(id).map(s => s.name)
                    });
                }
            }
        });
        return result;
    }

    clear() {
        this.segments = [];
        this.layers = [];
        this.rowsByLayer.clear();
        this.nextId = 0;
    }

    // used by import, which brings its own ids
    adoptIds() {
        this.nextId = this.segments.reduce((m, s) => Math.max(m, s.id + 1), 0);
    }
}

// source row -> row in the original PLY file. The loader usually leaves a morton
// permutation in place, so labels must be written and read through it or they
// land on the wrong gaussians.
const plyRowOrder = (splat: Splat): Uint32Array | null => {
    const source = splat.resource?.source;
    return (source instanceof PermutedChunkSource) ? source.order : null;
};

const registerSegmentEvents = (events: Events) => {
    const store = new Map<Splat, SplatSegments>();

    const dataOf = (splat: Splat): SplatSegments | null => {
        if (!splat) {
            return null;
        }
        let data = store.get(splat);
        if (!data) {
            data = new SplatSegments(splat.resource.numRows);
            store.set(splat, data);
        }
        return data;
    };

    const selected = () => events.invoke('selection') as Splat;

    // which source rows are still instanced. Rebuilt whenever the scene changes
    // so counts and exports follow a delete, and follow its undo just as well.
    const refreshLive = (splat: Splat, data: SplatSegments) => {
        const { instances } = splat;
        if (instances.numRemoved === 0) {
            data.liveRows = null;
            return;
        }
        const live = new Uint8Array(data.numRows);
        const { sourceRow } = instances;
        for (let i = 0; i < instances.count; ++i) {
            live[sourceRow[i]] = 1;
        }
        data.liveRows = live;
    };

    const changed = () => {
        const splat = selected();
        const data = splat ? dataOf(splat) : null;
        if (splat && data) {
            refreshLive(splat, data);
        }
        events.fire('segments.changed');
    };

    events.function('segments.data', () => dataOf(selected()));

    let activeLayer = DEFAULT_LAYER;

    events.function('segments.activeLayer', () => activeLayer);

    events.on('segments.setActiveLayer', (layer: string) => {
        activeLayer = layer || DEFAULT_LAYER;
        changed();
    });

    // assign the currently selected gaussians to a segment, creating it if needed
    events.function('segments.assign', (layer: string, name: string, segmentId?: number, parentId?: number | null) => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data || !name.trim()) {
            return null;
        }

        const segment = (segmentId !== undefined && segmentId !== null) ?
            data.segmentById(segmentId) :
            (data.findSegment(layer, name.trim(), parentId ?? null) ??
             data.createSegment(layer, name.trim(), parentId ?? null));

        if (!segment) {
            return null;
        }

        const rows = data.rows(segment.layer);
        const { instances } = splat;
        const { flags, sourceRow } = instances;
        let count = 0;
        for (let i = 0; i < instances.count; ++i) {
            if (flags[i] === State.selected) {
                rows[sourceRow[i]] = segment.id;
                count++;
            }
        }
        changed();
        return { segment, count };
    });

    // clear the label of the selected gaussians, on one layer or on all of them
    events.on('segments.clearSelected', (layer?: string) => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return;
        }
        const layers = layer ? [layer] : data.layers.slice();
        const { instances } = splat;
        const { flags, sourceRow } = instances;
        layers.forEach((l) => {
            const rows = data.rows(l);
            for (let i = 0; i < instances.count; ++i) {
                if (flags[i] === State.selected) {
                    rows[sourceRow[i]] = NO_LABEL;
                }
            }
        });
        changed();
    });

    // select every gaussian carrying a given segment
    events.on('segments.select', (segmentId: number) => {
        const splat = selected();
        const data = dataOf(splat);
        const segment = data?.segmentById(segmentId);
        if (!splat || !segment) {
            return;
        }
        // paint the viewport highlight in this label's own colour, so what is
        // lit up on the model matches the swatch in the list
        const colour = parseColor(segment.color);
        if (colour) {
            events.fire('setSelectedClr', colour);
        }

        const rows = data.rows(segment.layer);
        // selecting a label selects everything below it in the tree as well
        const wanted = new Set(data.descendantsOf(segment.id));
        const { instances } = splat;
        const { sourceRow } = instances;
        const mask = new Uint8Array(instances.count);
        for (let i = 0; i < instances.count; ++i) {
            mask[i] = wanted.has(rows[sourceRow[i]]) ? 255 : 0;
        }
        events.fire('select.mask', 'set', mask);
    });

    events.on('segments.setParent', (segmentId: number, parentId: number | null) => {
        dataOf(selected())?.setParent(segmentId, parentId);
        changed();
    });

    // select every gaussian that has (or lacks) a label on a layer. Used by the
    // panel to find the parts still untouched, and to hide the finished ones so
    // they cannot be painted over by accident.
    const selectByLabelled = (layer: string | undefined, wantLabelled: boolean) => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return 0;
        }
        const target = layer || data.layers[0] || DEFAULT_LAYER;
        if (!data.hasLayer(target)) {
            return 0;
        }
        const rows = data.rows(target);
        const { instances } = splat;
        const { sourceRow } = instances;
        const mask = new Uint8Array(instances.count);
        let count = 0;
        for (let i = 0; i < instances.count; ++i) {
            const hit = rows[sourceRow[i]] !== NO_LABEL;
            if (hit === wantLabelled) {
                mask[i] = 255;
                count++;
            }
        }
        events.fire('select.mask', 'set', mask);
        return count;
    };

    events.function('segments.selectUnlabelled', (layer?: string) => selectByLabelled(layer, false));
    events.function('segments.selectLabelled', (layer?: string) => selectByLabelled(layer, true));

    events.on('segments.rename', (segmentId: number, name: string) => {
        dataOf(selected())?.renameSegment(segmentId, name);
        changed();
    });

    events.on('segments.delete', (segmentId: number) => {
        dataOf(selected())?.deleteSegment(segmentId);
        changed();
    });

    events.on('segments.deleteLayer', (layer: string) => {
        dataOf(selected())?.deleteLayer(layer);
        changed();
    });

    events.on('segments.setArtifact', (name: string, id: string) => {
        const data = dataOf(selected());
        if (data) {
            data.artifactName = name.trim();
            data.artifactId = id.trim();
        }
    });

    // labels of one instance, for the label tool's tooltip
    events.function('segments.labelsAt', (splat: Splat, instanceIndex: number) => {
        const data = dataOf(splat);
        if (!data || instanceIndex < 0 || instanceIndex >= splat.instances.count) {
            return [] as LabelHit[];
        }
        return data.labelsOfRow(splat.instances.sourceRow[instanceIndex]);
    });

    // ---- file format -------------------------------------------------------

    // The base layer is the first one created. It carries the part hierarchy and
    // every other layer references it: a damage ROI records which base-layer
    // objects its gaussians sit on.
    const baseLayerOf = (data: SplatSegments) => data.layers[0] ?? DEFAULT_LAYER;

    // One document per layer. The base layer keeps the hierarchy format; the
    // others are written as ROIs (주관사 "ROI 저작 정보" v1.0).
    const serializeLayer = (splat: Splat, data: SplatSegments, layer: string) => {
        const order = plyRowOrder(splat);
        const toFile = (row: number) => (order ? order[row] : row);
        const numRows = data.numRows;
        const rows = data.rows(layer);
        // a deleted gaussian is no longer part of the model, so it is written to
        // no layer. Indices stay relative to the original PLY either way.
        const live = data.liveRows;

        if (layer === baseLayerOf(data)) {
            // one label id per gaussian, in PLY file order
            const labels: number[] = new Array(numRows).fill(NO_LABEL);
            for (let row = 0; row < numRows; ++row) {
                labels[toFile(row)] = (live && live[row] === 0) ? NO_LABEL : rows[row];
            }
            return {
                Format_Version: ROI_FORMAT_VERSION,
                version: FILE_VERSION,
                HeritageName: data.artifactName,
                HeritageId: data.artifactId,
                numGaussians: numRows,
                layer,
                parts: data.segmentsOfLayer(layer).map(s => ({
                    id: s.id, parent: s.parent, name: s.name, color: s.color
                })),
                labels
            };
        }

        const baseRows = data.rows(baseLayerOf(data));
        const rois = data.segmentsOfLayer(layer).map((segment) => {
            const gaussians: number[] = [];
            const objects = new Set<number>();
            for (let row = 0; row < numRows; ++row) {
                if (rows[row] === segment.id && (!live || live[row] !== 0)) {
                    gaussians.push(toFile(row));
                    if (baseRows[row] !== NO_LABEL) {
                        objects.add(baseRows[row]);
                    }
                }
            }
            gaussians.sort((a, b) => a - b);
            return {
                ROI_ID: segment.id,
                Name: segment.name,
                Object_Indices: [...objects].sort((a, b) => a - b),
                Gaussian_Indices: gaussians,
                Text: ''
            };
        });

        return {
            Format_Version: ROI_FORMAT_VERSION,
            Model: { Model_ID: data.artifactId, Model_Version: MODEL_VERSION },
            HeritageName: data.artifactName,
            numGaussians: numRows,
            Layer: layer,
            Base_Layer: baseLayerOf(data),
            ROIs: rois
        };
    };

    // Move a document's gaussian list out to its own binary file, leaving the
    // file's name in its place. Returns one entry per file written; the caller
    // owns the naming scheme, so it passes the stem the names are built from.
    events.function('segments.splitBinary', (doc: any, stem: string) => {
        const written: { name: string, buffer: ArrayBuffer }[] = [];

        if (Array.isArray(doc.labels)) {
            const values = doc.labels as number[];
            const view = new Int16Array(values.length);
            for (let i = 0; i < values.length; ++i) {
                view[i] = values[i];
            }
            const name = `${stem}.bin`;
            doc.labels = name;
            written.push({ name, buffer: toLittleEndian(view) });
            return written;
        }

        if (Array.isArray(doc.ROIs)) {
            // a file per ROI: the JSON holds one path per ROI and no offsets, so
            // reading one is reading a whole file
            doc.ROIs.forEach((roi: any) => {
                const indices: number[] = Array.isArray(roi.Gaussian_Indices) ? roi.Gaussian_Indices : [];
                const name = `${stem}.${roi.ROI_ID}.bin`;
                roi.Gaussian_Indices = name;
                written.push({ name, buffer: toLittleEndian(Uint32Array.from(indices)) });
            });
        }

        return written;
    });

    // The inverse: put the numbers back so the readers below see the shape they
    // always have. `find` hands back the bytes of a named file, or null.
    // A document whose lists are still inline passes through untouched, which is
    // what keeps files exported before this readable.
    events.function('segments.inlineBinary', (doc: any, find: (name: string) => ArrayBuffer | null) => {
        const read = (name: string, width: number) => {
            const buffer = find(name);
            return buffer ? fromLittleEndian(buffer, width) : null;
        };

        // the descriptor object this format used briefly, before 주관사 asked for
        // a bare path
        const pathOf = (value: any) => {
            if (typeof value === 'string') {
                return value;
            }
            return (value && typeof value === 'object' && typeof value.file === 'string') ? value.file : null;
        };

        const labelsPath = pathOf(doc?.labels);
        if (labelsPath) {
            const buffer = read(labelsPath, LABEL_BYTES);
            if (!buffer) {
                return 'missing-bin';
            }
            doc.labels = Array.from(new Int16Array(buffer));
            return 'ok';
        }

        if (Array.isArray(doc?.ROIs)) {
            for (const roi of doc.ROIs) {
                const path = pathOf(roi.Gaussian_Indices);
                if (!path) {
                    continue;
                }
                const buffer = read(path, INDEX_BYTES);
                if (!buffer) {
                    return 'missing-bin';
                }
                const view = new Uint32Array(buffer);
                const descriptor = roi.Gaussian_Indices;
                roi.Gaussian_Indices = (descriptor && typeof descriptor === 'object') ?
                    // the one-blob-with-offsets layout, read back by its own rules
                    Array.from(view.subarray(
                        (descriptor.offset ?? 0) / INDEX_BYTES,
                        (descriptor.offset ?? 0) / INDEX_BYTES + descriptor.count
                    )) :
                    Array.from(view);
            }
            return 'ok';
        }

        return 'ok';
    });

    // [{ layer, base, doc }] — one entry per layer, for the export button
    events.function('segments.serializeAll', () => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data || data.layers.length === 0) {
            return null;
        }
        const base = baseLayerOf(data);
        return data.layers.map(layer => ({
            layer,
            base: layer === base,
            doc: serializeLayer(splat, data, layer)
        }));
    });

    // kept for callers that still want a single combined document
    events.function('segments.serialize', () => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return null;
        }
        return serializeLayer(splat, data, baseLayerOf(data));
    });

    // ---- import ------------------------------------------------------------

    // replace one layer without touching the others
    const dropLayer = (data: SplatSegments, layer: string) => {
        if (data.hasLayer(layer)) {
            data.deleteLayer(layer);
        }
    };

    const adoptParts = (data: SplatSegments, layer: string, parts: any[]) => {
        const incoming: Segment[] = parts.map((s: any, i: number) => ({
            id: typeof s.id === 'number' ? s.id : i,
            name: s.name ?? s.partName ?? s.Name ?? `label ${i}`,
            layer,
            color: s.color ?? PALETTE[i % PALETTE.length],
            parent: typeof s.parent === 'number' ? s.parent : null
        }));
        data.segments = data.segments.concat(incoming);
        data.rows(layer);
        data.adoptIds();
        return incoming;
    };

    const readIdentity = (data: SplatSegments, doc: any) => {
        const name = doc.HeritageName ?? doc.artifactName;
        const id = doc.HeritageId ?? doc.Model?.Model_ID ?? doc.artifactId;
        if (typeof name === 'string' && name.trim()) {
            data.artifactName = name.trim();
        }
        if (typeof id === 'string' && id.trim()) {
            data.artifactId = id.trim();
        }
    };

    events.function('segments.deserialize', (doc: any) => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return 'no-splat';
        }
        if (!doc || typeof doc !== 'object') {
            return 'bad-format';
        }

        const order = plyRowOrder(splat);
        const toFile = (row: number) => (order ? order[row] : row);

        // ---- ROI file: one layer of flat labels, no hierarchy ----
        if (Array.isArray(doc.ROIs)) {
            if (typeof doc.numGaussians === 'number' && doc.numGaussians !== data.numRows) {
                return 'count-mismatch';
            }
            const layer = typeof doc.Layer === 'string' && doc.Layer ? doc.Layer : DEFAULT_LAYER;
            readIdentity(data, doc);
            dropLayer(data, layer);
            adoptParts(data, layer, doc.ROIs.map((r: any) => ({
                id: r.ROI_ID, name: r.Name, color: r.color
            })));
            const rows = data.rows(layer);
            doc.ROIs.forEach((roi: any) => {
                const fileIndices: number[] = Array.isArray(roi.Gaussian_Indices) ? roi.Gaussian_Indices : [];
                const wanted = new Set(fileIndices);
                for (let row = 0; row < data.numRows; ++row) {
                    if (wanted.has(toFile(row))) {
                        rows[row] = roi.ROI_ID;
                    }
                }
            });
            activeLayer = layer;
            changed();
            return 'ok';
        }

        if (!Array.isArray(doc.labels)) {
            return 'bad-format';
        }
        if (doc.labels.length !== data.numRows) {
            return 'count-mismatch';
        }

        // ---- single-layer hierarchy file ----
        if (typeof doc.layer === 'string' && doc.layer) {
            const layer = doc.layer;
            readIdentity(data, doc);
            dropLayer(data, layer);
            adoptParts(data, layer, doc.parts ?? []);
            const rows = data.rows(layer);
            for (let row = 0; row < data.numRows; ++row) {
                const value = doc.labels[toFile(row)];
                const id = Array.isArray(value) ? (value[0] ?? NO_LABEL) : value;
                rows[row] = (typeof id === 'number' && data.segmentById(id)) ? id : NO_LABEL;
            }
            activeLayer = layer;
            changed();
            return 'ok';
        }

        // ---- combined file (v1-v4): replaces the whole document ----
        data.clear();
        readIdentity(data, doc);

        // v1 used `name`, v2 used `partName`, v3 adds `layer`, v4 adds `parent`
        const incoming: Segment[] = ((doc.parts ?? doc.segments) ?? []).map((s: any, i: number) => ({
            id: typeof s.id === 'number' ? s.id : i,
            name: s.name ?? s.partName ?? `segment ${i}`,
            layer: s.layer ?? DEFAULT_LAYER,
            color: s.color ?? PALETTE[i % PALETTE.length],
            parent: typeof s.parent === 'number' ? s.parent : null
        }));
        data.segments = incoming;
        incoming.forEach(s => data.rows(s.layer));
        data.adoptIds();

        for (let row = 0; row < data.numRows; ++row) {
            const value = doc.labels[toFile(row)];
            const ids: number[] = Array.isArray(value) ? value : (value === NO_LABEL ? [] : [value]);
            ids.forEach((id) => {
                const segment = data.segmentById(id);
                if (segment) {
                    data.rows(segment.layer)[row] = id;
                }
            });
        }

        activeLayer = data.layers[0] ?? DEFAULT_LAYER;
        changed();
        return 'ok';
    });

    events.on('selection.changed', () => changed());
    events.on('splat.stateChanged', () => changed());
};

export { registerSegmentEvents, SplatSegments, Segment, LabelHit, DEFAULT_LAYER, NO_LABEL, FILE_VERSION };
