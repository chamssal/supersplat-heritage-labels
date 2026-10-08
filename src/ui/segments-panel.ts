import { Button, Container, Label, SelectInput, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { DEFAULT_LAYER, Segment, SplatSegments } from '../segments';
import { zip, unzip, ZipEntry } from '../zip';
import { i18n } from './localization';
import deleteSvg from './svg/delete.svg';
import exportSvg from './svg/export.svg';
import importSvg from './svg/import.svg';
import newSvg from './svg/new.svg';
import selectAddSvg from './svg/select-add.svg';
import tagSvg from './svg/tag.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const iconButton = (svg: string, className: string, ariaKey: string) => {
    const button = new Container({ class: ['segments-icon-button', className] });
    button.dom.appendChild(createSvg(svg));
    button.dom.setAttribute('role', 'button');
    button.dom.setAttribute('tabindex', '0');
    i18n.onChange(() => {
        const text = i18n.t(ariaKey);
        button.dom.setAttribute('aria-label', text);
        // native tooltip: the four row buttons look alike, so hovering must explain them
        button.dom.setAttribute('title', text);
    }, button);
    return button;
};

// Segment labels, grouped by layer. A gaussian carries at most one label per
// layer, so the layers are parallel axes: "부재" and "손상" can both apply to the
// same gaussian without either containing the other.
//
// Inside a layer the labels form a tree. Each label may name a parent label of
// the same layer, so a hierarchy of any depth is expressed without inventing a
// layer per level. The list below renders that tree, indented by depth.
class SegmentsPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'segments-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // ---- header ---------------------------------------------------------

        const header = new Container({ class: 'panel-header' });

        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(tagSvg));

        const headerLabel = new Label({ class: 'panel-header-label' });
        i18n.bindText(headerLabel, 'panel.segments');

        header.append(icon);
        header.append(headerLabel);

        // ---- artifact identity ---------------------------------------------

        const artifactRow = new Container({ class: 'segments-row' });
        const artifactNameLabel = new Label({ class: 'segments-field-label' });
        i18n.bindText(artifactNameLabel, 'panel.segments.artifact-name');
        const artifactName = new TextInput({ class: 'segments-text' });
        artifactRow.append(artifactNameLabel);
        artifactRow.append(artifactName);

        const artifactIdRow = new Container({ class: 'segments-row' });
        const artifactIdLabel = new Label({ class: 'segments-field-label' });
        i18n.bindText(artifactIdLabel, 'panel.segments.artifact-id');
        const artifactId = new TextInput({ class: 'segments-text' });
        artifactIdRow.append(artifactIdLabel);
        artifactIdRow.append(artifactId);

        const pushArtifact = () => {
            events.fire('segments.setArtifact', artifactName.value ?? '', artifactId.value ?? '');
        };
        artifactName.on('change', pushArtifact);
        artifactId.on('change', pushArtifact);

        // ---- selection status ----------------------------------------------

        const status = new Label({ class: 'segments-status' });

        // ---- the label being worked on --------------------------------------
        // Adding to a label that already exists must not mean retyping its name:
        // clicking a row in the list below makes it the active label, and this
        // bar drops the current selection into it.
        let activeId: number | null = null;

        const activeRow = new Container({ class: 'segments-active-row' });
        const activeSwatch = new Label({ class: 'segments-swatch' });
        const activeName = new Label({ class: 'segments-active-name' });
        const activeAdd = new Button({ class: 'segments-active-add' });
        i18n.bindText(activeAdd, 'panel.segments.add-to-active');
        activeRow.append(activeSwatch);
        activeRow.append(activeName);
        activeRow.append(activeAdd);

        // ---- assign new label ----------------------------------------------

        const assignRow = new Container({ class: 'segments-assign-row' });
        const layerInput = new TextInput({ class: 'segments-layer-input' });
        i18n.onChange(() => {
            layerInput.placeholder = i18n.t('panel.segments.layer-placeholder');
        }, layerInput);
        const nameInput = new TextInput({ class: 'segments-name-input' });
        i18n.onChange(() => {
            nameInput.placeholder = i18n.t('panel.segments.name-placeholder');
        }, nameInput);
        const assignButton = new Button({ class: 'segments-assign-button' });
        i18n.bindText(assignButton, 'panel.segments.assign');

        assignRow.append(layerInput);
        assignRow.append(nameInput);
        assignRow.append(assignButton);

        // ---- parent of the label about to be created ------------------------

        const parentRow = new Container({ class: 'segments-row' });
        const parentLabel = new Label({ class: 'segments-field-label' });
        i18n.bindText(parentLabel, 'panel.segments.parent');
        const NO_PARENT = 'none';
        const parentSelect = new SelectInput({
            class: 'segments-parent-select',
            defaultValue: NO_PARENT,
            // pcui needs at least one option at construction or it renders blank
            options: [{ v: NO_PARENT, t: '—' }]
        });
        parentRow.append(parentLabel);
        parentRow.append(parentSelect);

        // the options depend on the layer being typed into, so they are rebuilt
        // whenever the list is rebuilt or the layer field changes
        const refreshParents = () => {
            const data = events.invoke('segments.data') as SplatSegments;
            const layer = (layerInput.value ?? '').trim() || DEFAULT_LAYER;
            const options = [{ v: NO_PARENT, t: i18n.t('panel.segments.no-parent') }];
            if (data) {
                // walk the tree so the menu reads in the same order as the list,
                // and show each label by its own name indented by depth. The full
                // path would put the shared prefix first and cut off the part that
                // actually tells the entries apart.
                const walk = (segment: Segment, depth: number) => {
                    options.push({
                        v: `${segment.id}`,
                        t: `${'\u00a0\u00a0\u00a0'.repeat(depth)}${segment.name}`
                    });
                    data.childrenOf(segment.id).forEach(child => walk(child, depth + 1));
                };
                data.rootsOfLayer(layer).forEach(segment => walk(segment, 0));
            }
            const previous = parentSelect.value;
            parentSelect.options = options;
            parentSelect.value = options.some(o => o.v === previous) ? previous : NO_PARENT;
        };

        layerInput.on('change', refreshParents);

        const hint = new Label({ class: 'segments-hint' });
        i18n.bindText(hint, 'panel.segments.hint');

        // ---- layer list ------------------------------------------------------

        const list = new Container({ class: 'segments-list' });

        // ---- footer ----------------------------------------------------------

        // ---- work helpers ---------------------------------------------------
        // Painting a large model is mostly a problem of seeing what is left, so
        // these three act on the whole layer rather than on one label.
        const helpers = new Container({ class: 'segments-footer' });

        const unlabelledButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(unlabelledButton, 'panel.segments.select-unlabelled');
        const hideDoneButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(hideDoneButton, 'panel.segments.hide-done');
        const showAllButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(showAllButton, 'panel.segments.show-all');

        helpers.append(unlabelledButton);
        helpers.append(hideDoneButton);
        helpers.append(showAllButton);

        const currentLayer = () => (layerInput.value ?? '').trim() || undefined;

        // what is still untouched on this layer
        unlabelledButton.on('click', () => {
            events.invoke('segments.selectUnlabelled', currentLayer());
        });

        // finished parts go out of the way: hidden gaussians cannot be picked,
        // so the next part can be painted without eating into the previous one
        hideDoneButton.on('click', () => {
            const count = events.invoke('segments.selectLabelled', currentLayer()) as number;
            if (count > 0) {
                events.fire('select.hide');
            }
        });

        showAllButton.on('click', () => {
            events.fire('select.unhide');
            events.fire('select.none');
        });

        const footer = new Container({ class: 'segments-footer' });
        const clearButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(clearButton, 'panel.segments.clear-selected');
        const importButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(importButton, 'panel.segments.import');
        const exportButton = new Button({ class: 'segments-footer-button' });
        i18n.bindText(exportButton, 'panel.segments.export');
        footer.append(clearButton);
        footer.append(importButton);
        footer.append(exportButton);

        this.append(header);
        this.append(artifactRow);
        this.append(artifactIdRow);
        this.append(status);
        this.append(activeRow);
        this.append(assignRow);
        this.append(parentRow);
        this.append(list);
        this.append(helpers);
        this.append(footer);
        this.append(hint);

        // ---- the active label -------------------------------------------------

        const refreshActive = () => {
            const data = events.invoke('segments.data') as SplatSegments;
            const segment = (data && activeId !== null) ? data.segmentById(activeId) : null;
            if (!segment) {
                activeId = null;
                activeSwatch.dom.style.backgroundColor = 'transparent';
                activeName.text = i18n.t('panel.segments.active-none');
                activeName.class.add('segments-active-empty');
                activeName.dom.removeAttribute('title');
                activeAdd.enabled = false;
                return;
            }
            const path = data.pathOf(segment.id).map(s => s.name).join(' \u203a ');
            activeSwatch.dom.style.backgroundColor = segment.color;
            activeName.text = path;
            activeName.dom.setAttribute('title', `${segment.layer}: ${path}`);
            activeName.class.remove('segments-active-empty');
            activeAdd.enabled = true;
        };

        const setActive = (id: number | null) => {
            activeId = id;
            refreshActive();
            // repaint the highlight in place: a full rebuild would blow away the
            // text cursor if the click landed in a name field
            list.dom.querySelectorAll('.segments-item.active').forEach(el => el.classList.remove('active'));
            if (id !== null) {
                list.dom.querySelector(`.segments-item[data-segment-id="${id}"]`)?.classList.add('active');
            }
        };

        const assignToActive = () => {
            const data = events.invoke('segments.data') as SplatSegments;
            const segment = (data && activeId !== null) ? data.segmentById(activeId) : null;
            if (!segment) {
                return;
            }
            events.invoke('segments.assign', segment.layer, segment.name, segment.id);
        };

        activeAdd.on('click', assignToActive);
        events.on('segments.assignActive', assignToActive);

        // ---- rendering the list ----------------------------------------------

        const rebuild = () => {
            const data = events.invoke('segments.data') as SplatSegments;

            list.dom.textContent = '';

            if (!data) {
                status.text = i18n.t('panel.segments.no-layer');
                return;
            }

            if (artifactName.value !== data.artifactName) {
                artifactName.value = data.artifactName;
            }
            if (artifactId.value !== data.artifactId) {
                artifactId.value = data.artifactId;
            }

            const splat = events.invoke('selection');
            const deleted = splat?.numDeleted ?? 0;
            // deleted gaussians keep their label (so undo restores both) but stop
            // counting and stop being exported: say so rather than let the counts
            // look wrong
            status.text = i18n.t('panel.segments.selected', {
                count: i18n.formatInteger(splat?.numSelected ?? 0)
            }) + (deleted > 0 ?
                `  ${i18n.t('panel.segments.deleted', { count: i18n.formatInteger(deleted) })}` :
                '');

            data.layers.forEach((layer) => {
                const group = new Container({ class: 'segments-group' });

                const groupHeader = new Container({ class: 'segments-group-header' });
                // the first layer is the base: the other layers reference its labels
                const isBase = data.layers[0] === layer;
                const groupName = new Label({
                    class: 'segments-group-name',
                    text: isBase ? `${layer}  ${i18n.t('panel.segments.base-layer')}` : layer
                });
                const groupCount = new Label({
                    class: 'segments-group-count',
                    text: `${data.segmentsOfLayer(layer).length}`
                });
                const groupDelete = iconButton(deleteSvg, 'segments-group-delete', 'panel.segments.delete-layer');
                groupDelete.dom.addEventListener('click', () => events.fire('segments.deleteLayer', layer));

                groupHeader.append(groupName);
                groupHeader.append(groupCount);
                // which layer is the base decides the whole export's shape, so it
                // must be visible and changeable rather than implied by the order
                // the layers happened to be created in
                if (!isBase) {
                    const makeBase = new Button({ class: 'segments-group-base' });
                    i18n.bindText(makeBase, 'panel.segments.make-base');
                    i18n.onChange(() => {
                        makeBase.dom.setAttribute('title', i18n.t('panel.segments.make-base-tip'));
                    }, makeBase);
                    makeBase.on('click', () => events.fire('segments.setBaseLayer', layer));
                    groupHeader.append(makeBase);
                }
                groupHeader.append(groupDelete);
                group.append(groupHeader);

                const addRow = (segment: Segment, depth: number) => {
                    const row = new Container({ class: 'segments-item' });
                    // the indent stops growing past a few levels, otherwise a deep
                    // label has no room left for its name
                    row.dom.style.paddingLeft = `${Math.min(depth, 4) * 10}px`;
                    row.dom.dataset.segmentId = `${segment.id}`;
                    if (segment.id === activeId) {
                        row.dom.classList.add('active');
                    }
                    // clicking anywhere on the row makes it the label being worked
                    // on. Focus is dropped unless the click was meant for the name
                    // field, so the keyboard shortcut keeps working afterwards.
                    row.dom.addEventListener('pointerdown', (e: PointerEvent) => {
                        setActive(segment.id);
                        if (!(e.target instanceof HTMLInputElement)) {
                            (document.activeElement as HTMLElement)?.blur?.();
                        }
                    });

                    const swatch = new Label({ class: 'segments-swatch' });
                    swatch.dom.style.backgroundColor = segment.color;

                    const name = new TextInput({ class: 'segments-item-name', value: segment.name });
                    // the row is narrow when nested, so the full path lives in the tooltip
                    name.dom.setAttribute('title', data.pathOf(segment.id).map(s => s.name).join(' › '));
                    name.on('change', (value: string) => {
                        if (value && value !== segment.name) {
                            events.fire('segments.rename', segment.id, value);
                        }
                    });

                    // own gaussians, then the whole subtree when it has children
                    const subtree = data.descendantsOf(segment.id);
                    const own = data.countOf(segment.id);
                    const total = subtree.reduce((sum, id) => sum + data.countOf(id), 0);
                    const count = new Label({
                        class: 'segments-item-count',
                        text: total === own ?
                            i18n.formatInteger(own) :
                            `${i18n.formatInteger(own)} / ${i18n.formatInteger(total)}`
                    });

                    const addButton = iconButton(selectAddSvg, 'segments-item-add', 'panel.segments.add-to');
                    addButton.dom.addEventListener('click', () => {
                        events.invoke('segments.assign', segment.layer, segment.name, segment.id);
                    });

                    // make this label the parent of the next one created
                    const childButton = iconButton(newSvg, 'segments-item-child', 'panel.segments.set-parent');
                    childButton.dom.addEventListener('click', () => {
                        layerInput.value = segment.layer;
                        refreshParents();
                        parentSelect.value = `${segment.id}`;
                        nameInput.focus();
                    });

                    const selectButton = iconButton(tagSvg, 'segments-item-select', 'panel.segments.select');
                    selectButton.dom.addEventListener('click', () => {
                        events.fire('segments.select', segment.id);
                    });

                    const deleteButton = iconButton(deleteSvg, 'segments-item-delete', 'panel.segments.delete');
                    deleteButton.dom.addEventListener('click', () => {
                        events.fire('segments.delete', segment.id);
                    });

                    row.append(swatch);
                    row.append(name);
                    row.append(count);
                    row.append(addButton);
                    row.append(childButton);
                    row.append(selectButton);
                    row.append(deleteButton);
                    group.append(row);

                    data.childrenOf(segment.id).forEach(child => addRow(child, depth + 1));
                };

                data.rootsOfLayer(layer).forEach(segment => addRow(segment, 0));

                list.append(group);
            });

            refreshParents();
            refreshActive();
        };

        // ---- actions ---------------------------------------------------------

        assignButton.on('click', () => {
            const layer = (layerInput.value ?? '').trim() || DEFAULT_LAYER;
            const name = (nameInput.value ?? '').trim();
            if (!name) {
                return;
            }
            const parentId = (!parentSelect.value || parentSelect.value === NO_PARENT) ?
                null : parseInt(parentSelect.value, 10);
            const result = events.invoke('segments.assign', layer, name, undefined, parentId) as
                { segment: Segment } | null;
            nameInput.value = '';
            // a label just created is almost always the next one to be painted
            if (result?.segment) {
                setActive(result.segment.id);
            }
        });

        clearButton.on('click', () => events.fire('segments.clearSelected'));

        // \w is ASCII only, so a Korean artifact name came out as "___". Keep any
        // letter or digit and fold the rest - spaces included - into one underscore.
        const sanitize = (value: string) => value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_');

        const save = (blob: Blob, filename: string) => {
            const url = window.URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.download = filename;
            anchor.href = url;
            anchor.click();
            window.URL.revokeObjectURL(url);
        };

        // One archive per export. A layer now writes a JSON and a binary for each
        // of its lists, which is more files than a browser will hand over without
        // asking - and the set only means anything together anyway.
        exportButton.on('click', async () => {
            const entries = events.invoke('segments.serializeAll') as
                { layer: string, base: boolean, doc: any }[];
            if (!entries || entries.length === 0) {
                return;
            }
            const artifact = sanitize(
                (entries[0].doc.HeritageId || entries[0].doc.HeritageName || 'labels') as string
            );

            const files: ZipEntry[] = [];
            const encoder = new TextEncoder();

            for (const { layer, base, doc } of entries) {
                const stem = `${artifact}_${sanitize(layer)}.${base ? 'labels' : 'roi'}`;
                // the gaussian list leaves the JSON and lands beside it: at two
                // bytes a gaussian the file stops growing with the model
                const bins = events.invoke('segments.splitBinary', doc, stem) as
                    { name: string, buffer: ArrayBuffer }[];
                files.push({
                    name: `${stem}.json`,
                    data: encoder.encode(JSON.stringify(doc, null, 1))
                });
                bins.forEach(bin => files.push({ name: bin.name, data: new Uint8Array(bin.buffer) }));
            }

            save(await zip(files), `${artifact}.labels.zip`);
        });

        importButton.on('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.bin,.zip,application/json,application/octet-stream,application/zip';
            // several layer files can be picked at once; each one replaces its layer
            input.multiple = true;
            input.onchange = async () => {
                let files = Array.from(input.files ?? []);
                if (files.length === 0) {
                    return;
                }

                // an archive stands for the files inside it, so unpack it and
                // carry on as if those had been picked
                for (const archive of files.filter(f => f.name.toLowerCase().endsWith('.zip'))) {
                    let unpacked;
                    try {
                        unpacked = await unzip(await archive.arrayBuffer());
                    } catch (error) {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('popup.error'),
                            message: `${archive.name}: ${i18n.t('panel.segments.import-bad-zip')}`
                        });
                        continue;
                    }
                    files = files.filter(f => f !== archive).concat(
                        unpacked.map(e => new File([e.data as BlobPart], e.name))
                    );
                }
                const bins = files.filter(f => f.name.toLowerCase().endsWith('.bin'));
                const docs = files.filter(f => !f.name.toLowerCase().endsWith('.bin'));
                // the base layer must land first so the ROI files can reference it
                docs.sort((a, b) => Number(b.name.includes('.labels.')) - Number(a.name.includes('.labels.')));

                // A download folder renames duplicates ("x.labels (1).bin"), so the
                // name the JSON recorded is a first guess, not a guarantee: strip
                // that suffix from both sides before comparing, and fall back to
                // the only file picked when there is only one.
                const key = (name: string) => name.toLowerCase()
                .replace(/\s*\(\d+\)(?=\.[^.]*$|$)/, '')
                .replace(/^.*[\\/]/, '');
                const binFor = (wanted: string) => {
                    const want = key(wanted);
                    return bins.find(f => key(f.name) === want) ??
                        (bins.length === 1 ? bins[0] : null);
                };

                for (const file of docs) {
                    let doc;
                    try {
                        doc = JSON.parse(await file.text());
                    } catch (error) {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('popup.error'),
                            message: `${file.name}: ${i18n.t('panel.segments.import-parse-error')}`
                        });
                        continue;
                    }

                    // inlineBinary asks for each file it needs by name; the reads
                    // are done up front because it is not an async function
                    const bytes = new Map<string, ArrayBuffer>();
                    for (const f of bins) {
                        bytes.set(key(f.name), await f.arrayBuffer());
                    }
                    const find = (name: string) => {
                        const match = binFor(name);
                        return match ? (bytes.get(key(match.name)) ?? null) : null;
                    };
                    const inlined = events.invoke('segments.inlineBinary', doc, find);
                    if (inlined !== 'ok') {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('popup.error'),
                            message: `${file.name}: ${i18n.t(`panel.segments.import-${inlined}`)}`
                        });
                        continue;
                    }

                    const result = events.invoke('segments.deserialize', doc);
                    if (result !== 'ok') {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('popup.error'),
                            message: `${file.name}: ${i18n.t(`panel.segments.import-${result}`)}`
                        });
                    }
                }
            };
            input.click();
        });

        // ---- visibility -------------------------------------------------------

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                if (visible) {
                    rebuild();
                }
                this.hidden = !visible;
                events.fire('segmentsPanel.visible', visible);
            }
        };

        events.function('segmentsPanel.visible', () => !this.hidden);
        events.on('segmentsPanel.setVisible', (visible: boolean) => setVisible(visible));
        events.on('segmentsPanel.toggleVisible', () => setVisible(this.hidden));

        // mutual exclusion with the sibling panels
        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('appearancePanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('overlaysPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });

        events.on('segments.changed', () => {
            if (!this.hidden) {
                rebuild();
            }
        });

        i18n.onChange(() => {
            if (!this.hidden) {
                rebuild();
            }
        }, this);

        tooltips.register(assignButton, () => i18n.t('panel.segments.assign'), 'top');
    }
}

export { SegmentsPanel };
