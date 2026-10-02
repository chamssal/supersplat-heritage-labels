import { Button, Container, Label, SelectInput, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { DEFAULT_LAYER, Segment, SplatSegments } from '../segments';
import { i18n } from './localization';
import deleteSvg from './svg/delete.svg';
import exportSvg from './svg/export.svg';
import importSvg from './svg/import.svg';
import newSvg from './svg/new.svg';
import selectAllSvg from './svg/select-all.svg';
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
                data.segmentsOfLayer(layer).forEach((segment) => {
                    options.push({
                        v: `${segment.id}`,
                        t: data.pathOf(segment.id).map(s => s.name).join(' › ')
                    });
                });
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
        this.append(assignRow);
        this.append(parentRow);
        this.append(list);
        this.append(helpers);
        this.append(footer);
        this.append(hint);

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
            status.text = i18n.t('panel.segments.selected', {
                count: i18n.formatInteger(splat?.numSelected ?? 0)
            });

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
                groupHeader.append(groupDelete);
                group.append(groupHeader);

                const addRow = (segment: Segment, depth: number) => {
                    const row = new Container({ class: 'segments-item' });
                    row.dom.style.paddingLeft = `${depth * 14}px`;

                    const swatch = new Label({ class: 'segments-swatch' });
                    swatch.dom.style.backgroundColor = segment.color;

                    const name = new TextInput({ class: 'segments-item-name', value: segment.name });
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

                    const addButton = iconButton(selectAllSvg, 'segments-item-add', 'panel.segments.add-to');
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
            events.invoke('segments.assign', layer, name, undefined, parentId);
            nameInput.value = '';
        });

        clearButton.on('click', () => events.fire('segments.clearSelected'));

        const sanitize = (value: string) => value.trim().replace(/[^\w.-]+/g, '_');

        const download = (doc: any, filename: string) => {
            const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.download = filename;
            anchor.href = url;
            anchor.click();
            window.URL.revokeObjectURL(url);
        };

        // one file per layer: the base layer keeps the hierarchy, the others are
        // written as ROIs that reference it
        exportButton.on('click', async () => {
            const entries = events.invoke('segments.serializeAll') as
                { layer: string, base: boolean, doc: any }[];
            if (!entries || entries.length === 0) {
                return;
            }
            const artifact = sanitize(
                (entries[0].doc.HeritageId || entries[0].doc.HeritageName || 'labels') as string
            );
            for (let i = 0; i < entries.length; ++i) {
                const { layer, base, doc } = entries[i];
                const suffix = base ? 'labels' : 'roi';
                download(doc, `${artifact}_${sanitize(layer)}.${suffix}.json`);
                // browsers drop downloads fired in the same tick
                if (i < entries.length - 1) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, 350);
                    });
                }
            }
        });

        importButton.on('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            // several layer files can be picked at once; each one replaces its layer
            input.multiple = true;
            input.onchange = async () => {
                const files = Array.from(input.files ?? []);
                if (files.length === 0) {
                    return;
                }
                // the base layer must land first so the ROI files can reference it
                files.sort((a, b) => Number(b.name.includes('.labels.')) - Number(a.name.includes('.labels.')));
                for (const file of files) {
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
