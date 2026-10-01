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

class SplatSegments {
    artifactName = '';
    artifactId = '';

    segments: Segment[] = [];
    layers: string[] = [];

    private rowsByLayer = new Map<string, Int32Array>();
    private nextId = 0;

    readonly numRows: number;

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

    findSegment(layer: string, name: string) {
        return this.segments.find(s => s.layer === layer && s.name === name) ?? null;
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
        let count = 0;
        for (let i = 0; i < rows.length; ++i) {
            if (rows[i] === id) {
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

    const changed = () => events.fire('segments.changed');

    events.function('segments.data', () => dataOf(selected()));

    events.function('segments.activeLayer', () => activeLayer);

    let activeLayer = DEFAULT_LAYER;

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
            (data.findSegment(layer, name.trim()) ??
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

    events.function('segments.serialize', () => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return null;
        }

        const order = plyRowOrder(splat);
        const numRows = data.numRows;
        const labels: number[][] = new Array(numRows);
        for (let i = 0; i < numRows; ++i) {
            labels[i] = [];
        }
        data.layers.forEach((layer) => {
            const rows = data.rows(layer);
            for (let row = 0; row < numRows; ++row) {
                const id = rows[row];
                if (id !== NO_LABEL) {
                    labels[order ? order[row] : row].push(id);
                }
            }
        });
        labels.forEach(l => l.sort((a, b) => a - b));

        return {
            version: FILE_VERSION,
            HeritageName: data.artifactName,
            HeritageId: data.artifactId,
            numGaussians: numRows,
            layers: data.layers.slice(),
            parts: data.segments.map(s => ({
                id: s.id, parent: s.parent, name: s.name, layer: s.layer, color: s.color
            })),
            labels
        };
    });

    events.function('segments.deserialize', (doc: any) => {
        const splat = selected();
        const data = dataOf(splat);
        if (!splat || !data) {
            return 'no-splat';
        }
        if (!doc || !Array.isArray(doc.labels)) {
            return 'bad-format';
        }
        if (doc.labels.length !== data.numRows) {
            return 'count-mismatch';
        }

        data.clear();
        // v3 writes HeritageName/HeritageId/parts; older files used artifactName/artifactId/segments
        const name = doc.HeritageName ?? doc.artifactName;
        const id = doc.HeritageId ?? doc.artifactId;
        data.artifactName = typeof name === 'string' ? name.trim() : '';
        data.artifactId = typeof id === 'string' ? id.trim() : '';

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

        const order = plyRowOrder(splat);
        for (let row = 0; row < data.numRows; ++row) {
            const value = doc.labels[order ? order[row] : row];
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
