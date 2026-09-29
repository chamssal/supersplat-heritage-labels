import { Container } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { LabelHit } from '../segments';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

class LabelTransformHandler {
    activate() {}
    deactivate() {}
}

// Click a gaussian and every label it carries is listed in a callout anchored to
// the clicked point. A gaussian holds at most one label per layer, so the
// callout has one row per layer.
class LabelTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container, annotationParent: HTMLElement) {
        let active = false;

        // tools are constructed before the selection events are registered, so
        // this starts empty and is filled by 'selection.changed' / activate()
        let splat: Splat = null;

        // the anchor in the splat's local space, so the callout tracks the model
        let anchor: Vec3 | null = null;
        let anchorSplat: Splat | null = null;
        let instanceIndex = -1;

        const world = new Vec3();
        const screen = new Vec3();

        const transformHandler = new LabelTransformHandler();

        // ---- callout dom ----------------------------------------------------

        const tip = document.createElement('div');
        tip.classList.add('label-tool-tip', 'hidden');

        const rows = document.createElement('div');
        rows.classList.add('label-tool-tip-rows');

        const index = document.createElement('div');
        index.classList.add('label-tool-tip-index');

        tip.appendChild(rows);
        tip.appendChild(index);

        const dot = document.createElement('div');
        dot.classList.add('label-tool-dot', 'hidden');

        annotationParent.appendChild(tip);
        annotationParent.appendChild(dot);

        const hideTip = () => {
            anchor = null;
            anchorSplat = null;
            instanceIndex = -1;
            tip.classList.add('hidden');
            dot.classList.add('hidden');
        };

        const buildTip = (labels: LabelHit[]) => {
            rows.textContent = '';

            if (labels.length === 0) {
                const row = document.createElement('div');
                row.classList.add('label-tool-tip-row', 'label-tool-tip-empty');
                row.textContent = i18n.t('label.no-label');
                rows.appendChild(row);
            } else {
                labels.forEach((label) => {
                    const row = document.createElement('div');
                    row.classList.add('label-tool-tip-row');

                    const swatch = document.createElement('span');
                    swatch.classList.add('label-tool-tip-swatch');
                    swatch.style.backgroundColor = label.color;

                    const layer = document.createElement('span');
                    layer.classList.add('label-tool-tip-layer');
                    layer.textContent = label.layer;

                    const name = document.createElement('span');
                    name.classList.add('label-tool-tip-name');
                    name.textContent = label.name;

                    row.appendChild(swatch);
                    row.appendChild(layer);
                    row.appendChild(name);
                    rows.appendChild(row);
                });
            }

            index.textContent = i18n.t('label.gaussian-index', { index: instanceIndex });
            tip.classList.remove('hidden');
            dot.classList.remove('hidden');
        };

        const place = () => {
            if (!anchor || !anchorSplat) {
                return;
            }

            const width = canvasContainer.dom.clientWidth;
            const height = canvasContainer.dom.clientHeight;

            anchorSplat.worldTransform.transformPoint(anchor, world);

            // behind the camera: nothing to point at
            const cameraPos = scene.camera.mainCamera.getPosition();
            const cameraFwd = scene.camera.mainCamera.forward;
            if (screen.sub2(world, cameraPos).dot(cameraFwd) <= 0) {
                tip.classList.add('hidden');
                dot.classList.add('hidden');
                return;
            }

            scene.camera.worldToScreen(world, screen);
            const x = screen.x * width;
            const y = screen.y * height;

            tip.classList.remove('hidden');
            dot.classList.remove('hidden');
            tip.style.left = `${x}px`;
            tip.style.top = `${y}px`;
            dot.style.left = `${x}px`;
            dot.style.top = `${y}px`;
        };

        // ---- pointer --------------------------------------------------------

        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        let clicked = false;
        let clickX = 0;
        let clickY = 0;

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
                clickX = e.offsetX;
                clickY = e.offsetY;
            }
        };

        const pointermove = (e: PointerEvent) => {
            // forgive small jitter between down and up; only a real drag cancels the click
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;

            const target = splat;
            if (!target) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            const width = canvasContainer.dom.clientWidth || 1;
            const height = canvasContainer.dom.clientHeight || 1;
            const nx = clickX / width;
            const ny = clickY / height;

            scene.camera.pickPrep(target, 'set');
            const picked = await scene.camera.pickRect(nx, ny, 1 / width, 1 / height);
            const id = picked?.[0];

            if (id === undefined || id === 0xffffffff || id >= target.instances.count) {
                hideTip();
                scene.forceRender = true;
                return;
            }

            // a depth pick gives the world point to anchor the callout to
            const hit = await scene.camera.intersect(nx, ny);

            // the camera may have moved or the tool closed while the picks were in flight
            if (!active || splat !== target) {
                return;
            }

            instanceIndex = id;
            anchorSplat = target;
            if (hit?.position) {
                anchor = new Vec3();
                target.worldTransform.clone().invert().transformPoint(hit.position, anchor);
            } else {
                anchor = null;
            }

            buildTip(events.invoke('segments.labelsAt', target, id) as LabelHit[]);

            if (!anchor) {
                // no depth hit: pin the callout where it was clicked
                tip.style.left = `${clickX}px`;
                tip.style.top = `${clickY}px`;
                dot.style.left = `${clickX}px`;
                dot.style.top = `${clickY}px`;
            } else {
                place();
            }

            scene.forceRender = true;
        };

        // ---- wiring ---------------------------------------------------------

        events.on('postrender', () => {
            if (active && anchor) {
                place();
            }
        });

        events.on('selection.changed', (selection: Splat) => {
            splat = selection;
            hideTip();
        });

        // a label changing under the callout should refresh it
        events.on('segments.changed', () => {
            if (active && anchorSplat && instanceIndex >= 0) {
                buildTip(events.invoke('segments.labelsAt', anchorSplat, instanceIndex) as LabelHit[]);
            }
        });

        this.activate = () => {
            active = true;
            splat = events.invoke('selection') as Splat;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            events.fire('transformHandler.push', transformHandler);
            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            hideTip();
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            events.fire('transformHandler.pop');
            scene.forceRender = true;
        };
    }
}

export { LabelTool };
