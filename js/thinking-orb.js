/*
 * Solving-orb renderer adapted from the ideas in `thinking-orbs`.
 * Copyright (c) Jakub Antalik. Original project distributed under the MIT License.
 *
 * This is a dependency-free Canvas 2D implementation for Aetheria's Android
 * WebView. It intentionally owns rendering lifecycle only; chat.js owns state.
 */

const mountedOrbs = new WeakMap();
const liveOrbs = new Set();

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let sharedThemeObserver = null;
let sharedRemovalObserver = null;
let pruneFrame = 0;

const SOLVING_OPTIONS = Object.freeze({
    baseSpeed: 1.82,
    latitudeRings: 9,
    longitudeDensity: 24,
    moveCount: 14,
    baseRadius: 0.63,
    depthRadius: 1.785,
    activeRadius: 0.315,
    farInk: 0.62,
    inkDepthSpan: 0.54,
    radiusScalingPower: 0.6,
    minimumRadius: 0.3,
    slotDuration: 0.42,
    activeSlotRatio: 0.7,
    restDuration: 1.2,
});

// The package's 64px `composing` preset, ported to this dependency-free
// renderer so the Capacitor WebView does not need React at runtime.
const COMPOSING_OPTIONS = Object.freeze({
    baseSpeed: 2.34,
    lanes: 3,
    segments: 44,
    ghostCount: 38,
    baseRadius: 0.935,
    depthRadius: 1.445,
    radiusScalingPower: 0.6,
    minimumRadius: 0.3,
    bandMultiplier: 3.9,
    wobbleMultiplier: 1,
});

function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
}

function hashValue(a, b) {
    const hash = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return hash - Math.floor(hash);
}

function createMoves() {
    const axes = ['x', 'y', 'z'];
    return Array.from({ length: SOLVING_OPTIONS.moveCount }, (_, index) => ({
        axis: axes[Math.floor(hashValue(index + 1, 1) * axes.length)],
        lower: -1 + Math.floor(hashValue(index + 1, 2) * 4) * 0.5,
        upper: -0.5 + Math.floor(hashValue(index + 1, 2) * 4) * 0.5,
        direction: hashValue(index + 1, 3) >= 0.5 ? 1 : -1,
    }));
}

function createLattice() {
    const points = [];
    for (let latitudeIndex = 0; latitudeIndex <= SOLVING_OPTIONS.latitudeRings; latitudeIndex += 1) {
        const latitude = -Math.PI / 2
            + (latitudeIndex / SOLVING_OPTIONS.latitudeRings) * Math.PI;
        const cosineLatitude = Math.cos(latitude);
        const sineLatitude = Math.sin(latitude);
        const longitudeCount = Math.max(
            1,
            Math.round(Math.abs(cosineLatitude) * SOLVING_OPTIONS.longitudeDensity),
        );

        for (let longitudeIndex = 0; longitudeIndex < longitudeCount; longitudeIndex += 1) {
            const longitude = (longitudeIndex / longitudeCount) * Math.PI * 2;
            points.push({
                x: cosineLatitude * Math.cos(longitude),
                y: sineLatitude,
                z: cosineLatitude * Math.sin(longitude),
            });
        }
    }
    return points;
}

const SOLVING_MOVES = createMoves();
const SPHERE_LATTICE = createLattice();

function easeTurn(value) {
    const progress = clamp(value);
    return 1 - ((1 - progress) ** 3);
}

function resolveSolveCycle(time) {
    const moveSpan = SOLVING_OPTIONS.moveCount * SOLVING_OPTIONS.slotDuration;
    const totalDuration = moveSpan * 2 + SOLVING_OPTIONS.restDuration;
    const cycleTime = ((time % totalDuration) + totalDuration) % totalDuration;
    const amounts = new Array(SOLVING_OPTIONS.moveCount).fill(0);
    let activeMove = -1;

    if (cycleTime < moveSpan) {
        for (let index = 0; index < SOLVING_OPTIONS.moveCount; index += 1) {
            const rawProgress = (
                cycleTime - index * SOLVING_OPTIONS.slotDuration
            ) / (
                SOLVING_OPTIONS.slotDuration * SOLVING_OPTIONS.activeSlotRatio
            );
            amounts[index] = easeTurn(rawProgress);
            if (rawProgress > 0 && rawProgress < 1) activeMove = index;
        }
    } else if (cycleTime < moveSpan * 2) {
        amounts.fill(1);
        const reverseTime = cycleTime - moveSpan;
        for (let reverseIndex = 0; reverseIndex < SOLVING_OPTIONS.moveCount; reverseIndex += 1) {
            const moveIndex = SOLVING_OPTIONS.moveCount - 1 - reverseIndex;
            const rawProgress = (
                reverseTime - reverseIndex * SOLVING_OPTIONS.slotDuration
            ) / (
                SOLVING_OPTIONS.slotDuration * SOLVING_OPTIONS.activeSlotRatio
            );
            amounts[moveIndex] = 1 - easeTurn(rawProgress);
            if (rawProgress > 0 && rawProgress < 1) activeMove = moveIndex;
        }
    }

    return { amounts, activeMove };
}

function rotateAroundAxis(point, axis, angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const { x, y, z } = point;

    if (axis === 'x') {
        point.y = y * cosine - z * sine;
        point.z = y * sine + z * cosine;
    } else if (axis === 'y') {
        point.x = x * cosine + z * sine;
        point.z = -x * sine + z * cosine;
    } else {
        point.x = x * cosine - y * sine;
        point.y = x * sine + y * cosine;
    }
}

function applySolvingMoves(sourcePoint, cycle) {
    const point = { ...sourcePoint };
    let inActiveMove = false;

    SOLVING_MOVES.forEach((move, index) => {
        const amount = cycle.amounts[index];
        if (amount <= 0) return;

        const coordinate = point[move.axis];
        if (coordinate < move.lower || coordinate > move.upper) return;

        rotateAroundAxis(point, move.axis, move.direction * Math.PI * 0.5 * amount);
        if (index === cycle.activeMove) inActiveMove = true;
    });

    return { point, inActiveMove };
}

function resolveDarkMode(target) {
    const explicitTheme = target.closest('[data-theme]');
    if (explicitTheme) return explicitTheme.dataset.theme === 'dark';
    if (target.closest('.dark-mode, .dark')) return true;
    return document.body?.classList.contains('dark-mode') ?? false;
}

function drawSolvingOrb(context, size, time, darkMode) {
    context.clearRect(0, 0, size, size);

    const center = size / 2;
    const sphereRadius = center * 0.82;
    const sizeScale = Math.pow(size / 300, SOLVING_OPTIONS.radiusScalingPower);
    const cycle = resolveSolveCycle(time);
    const yaw = time * 0.55;
    const tilt = 0.35 + 0.1 * Math.sin(time * 0.9);
    const yawCosine = Math.cos(yaw);
    const yawSine = Math.sin(yaw);
    const tiltCosine = Math.cos(tilt);
    const tiltSine = Math.sin(tilt);

    const dots = SPHERE_LATTICE.map((sourcePoint) => {
        const { point, inActiveMove } = applySolvingMoves(sourcePoint, cycle);

        const yawX = point.x * yawCosine + point.z * yawSine;
        const yawZ = -point.x * yawSine + point.z * yawCosine;
        const rotatedY = point.y * tiltCosine - yawZ * tiltSine;
        const rotatedZ = point.y * tiltSine + yawZ * tiltCosine;
        const depth = clamp((rotatedZ + 1) / 2);

        const radius = Math.max(
            SOLVING_OPTIONS.minimumRadius,
            (
                SOLVING_OPTIONS.baseRadius
                + SOLVING_OPTIONS.depthRadius * depth
                + (inActiveMove ? SOLVING_OPTIONS.activeRadius : 0)
            ) * sizeScale,
        );

        const white = clamp(
            SOLVING_OPTIONS.farInk
            - SOLVING_OPTIONS.inkDepthSpan * depth
            - (inActiveMove ? 0.14 : 0),
        );
        const grayscale = Math.round((darkMode ? 1 - white : white) * 255);

        return {
            x: center + yawX * sphereRadius,
            y: center - rotatedY * sphereRadius,
            z: rotatedZ,
            radius,
            color: `rgb(${grayscale} ${grayscale} ${grayscale})`,
        };
    }).sort((a, b) => a.z - b.z);

    for (const dot of dots) {
        context.beginPath();
        context.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        context.fillStyle = dot.color;
        context.fill();
    }
}

function fibonacciSpherePoint(index, count) {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (index + 0.5)) / count;
    const radius = Math.sqrt(1 - y * y);
    const angle = index * goldenAngle;
    return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
}

function createProjector(yaw, pitch, centerX, centerY, scale) {
    const sinePitch = Math.sin(pitch);
    const cosinePitch = Math.cos(pitch);
    const sineYaw = Math.sin(yaw);
    const cosineYaw = Math.cos(yaw);

    return (x, y, z) => {
        const yawX = x * cosineYaw + z * sineYaw;
        const yawZ = -x * sineYaw + z * cosineYaw;
        const projectedY = y * cosinePitch - yawZ * sinePitch;
        const projectedZ = y * sinePitch + yawZ * cosinePitch;
        return [
            centerX + yawX * scale,
            centerY - projectedY * scale,
            projectedZ,
        ];
    };
}

function paintOrbDots(context, dots, darkMode, minimumRadius) {
    dots.sort((a, b) => a.z - b.z);
    for (const dot of dots) {
        const alpha = dot.alpha ?? 1;
        if (alpha < 0.02) continue;
        const white = clamp(dot.white);
        const grayscale = Math.round((darkMode ? 1 - white : white) * 255);
        context.beginPath();
        context.arc(dot.x, dot.y, Math.max(minimumRadius, dot.radius), 0, Math.PI * 2);
        context.fillStyle = `rgba(${grayscale}, ${grayscale}, ${grayscale}, ${alpha})`;
        context.fill();
    }
}

function drawComposingOrb(context, size, time, darkMode) {
    context.clearRect(0, 0, size, size);

    const center = size / 2;
    const sphereRadius = center * 0.78;
    const project = createProjector(0, 0.3, center, center, 1);
    const sizeScale = Math.pow(size / 300, COMPOSING_OPTIONS.radiusScalingPower);
    const dots = [];

    for (let index = 0; index < COMPOSING_OPTIONS.ghostCount; index += 1) {
        const point = fibonacciSpherePoint(index, COMPOSING_OPTIONS.ghostCount);
        const [x, y, z] = project(
            point[0] * sphereRadius,
            point[1] * sphereRadius,
            point[2] * sphereRadius,
        );
        const depth = (z / sphereRadius + 1) / 2;
        dots.push({
            x,
            y,
            z,
            radius: 0.8 * sizeScale,
            white: 0.78,
            alpha: 0.1 + 0.22 * depth,
        });
    }

    // This basis and wobble match thinking-orbs' 64px composing/ribbon preset.
    const headingX = 1;
    const headingY = 0;
    const headingZ = 0;
    const tilt = 0.55;
    const latitudeX = 0;
    const latitudeY = Math.cos(tilt);
    const latitudeZ = Math.sin(tilt);
    const normalX = headingY * latitudeZ - headingZ * latitudeY;
    const normalY = headingZ * latitudeX - headingX * latitudeZ;
    const normalZ = headingX * latitudeY - headingY * latitudeX;
    const laneCount = Math.max(1, Math.round(
        COMPOSING_OPTIONS.lanes * COMPOSING_OPTIONS.bandMultiplier,
    ));

    for (let lane = 0; lane < laneCount; lane += 1) {
        const laneOffset = (lane - (laneCount - 1) / 2) * 0.075;
        const edgeDistance = Math.abs(lane - (laneCount - 1) / 2)
            / Math.max(1, (laneCount - 1) / 2);

        for (let segment = 0; segment < COMPOSING_OPTIONS.segments; segment += 1) {
            const angle = (segment / COMPOSING_OPTIONS.segments) * Math.PI * 2;
            const wobble = (
                0.16 * Math.sin(angle * 3 - time * 1.7 + lane * 0.22)
                + 0.07 * Math.sin(angle * 5 + time * 1.1)
            ) * COMPOSING_OPTIONS.wobbleMultiplier;
            const offset = laneOffset + wobble;
            const x = headingX * Math.cos(angle) + latitudeX * Math.sin(angle) + normalX * offset;
            const y = headingY * Math.cos(angle) + latitudeY * Math.sin(angle) + normalY * offset;
            const z = headingZ * Math.cos(angle) + latitudeZ * Math.sin(angle) + normalZ * offset;
            const length = Math.sqrt(x * x + y * y + z * z);
            const [projectedX, projectedY, projectedZ] = project(
                (x / length) * sphereRadius,
                (y / length) * sphereRadius,
                (z / length) * sphereRadius,
            );
            const depth = (projectedZ / sphereRadius + 1) / 2;

            dots.push({
                x: projectedX,
                y: projectedY,
                z: projectedZ,
                radius: (
                    COMPOSING_OPTIONS.baseRadius
                    + COMPOSING_OPTIONS.depthRadius * depth
                ) * (1 - 0.25 * edgeDistance) * sizeScale,
                white: 0.52 - 0.44 * depth + 0.18 * edgeDistance,
                alpha: 0.4 + 0.6 * depth,
            });
        }
    }

    paintOrbDots(context, dots, darkMode, COMPOSING_OPTIONS.minimumRadius);
}

const STATE_PRESETS = Object.freeze({
    solving: Object.freeze({
        baseSpeed: SOLVING_OPTIONS.baseSpeed,
        label: 'Solving...',
        draw: drawSolvingOrb,
    }),
    composing: Object.freeze({
        baseSpeed: COMPOSING_OPTIONS.baseSpeed,
        label: 'Composing...',
        draw: drawComposingOrb,
    }),
});

function syncAllOrbs({ redraw = false } = {}) {
    liveOrbs.forEach((orb) => {
        if (redraw) orb.refresh();
        orb.syncAnimation();
    });
}

function pruneDetachedOrbs() {
    pruneFrame = 0;
    liveOrbs.forEach((orb) => {
        if (!orb.canvas.isConnected) orb.destroy();
    });
}

function scheduleDetachedOrbPrune() {
    if (pruneFrame) return;
    pruneFrame = requestAnimationFrame(pruneDetachedOrbs);
}

function handleVisibilityChange() {
    syncAllOrbs();
}

function handleReducedMotionChange() {
    syncAllOrbs({ redraw: true });
}

function ensureSharedLifecycle() {
    if (!sharedThemeObserver) {
        sharedThemeObserver = new MutationObserver((records) => {
            if (records.some((record) => (
                record.type === 'attributes'
                && (record.attributeName === 'class' || record.attributeName === 'data-theme')
            ))) {
                syncAllOrbs({ redraw: true });
            }
        });
        sharedThemeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme'],
        });
        if (document.body) {
            sharedThemeObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'data-theme'],
            });
        }
    }

    if (!sharedRemovalObserver) {
        sharedRemovalObserver = new MutationObserver(scheduleDetachedOrbPrune);
        sharedRemovalObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (liveOrbs.size === 1) {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        reducedMotionQuery.addEventListener?.('change', handleReducedMotionChange);
    }
}

function releaseSharedLifecycle() {
    if (liveOrbs.size > 0) return;
    sharedThemeObserver?.disconnect();
    sharedRemovalObserver?.disconnect();
    sharedThemeObserver = null;
    sharedRemovalObserver = null;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    reducedMotionQuery.removeEventListener?.('change', handleReducedMotionChange);
    if (pruneFrame) cancelAnimationFrame(pruneFrame);
    pruneFrame = 0;
}

export class ThinkingOrb {
    constructor(target, {
        state = 'solving',
        size = 64,
        displaySize = size,
        speed = 0.25,
        paused = false,
        ariaLabel = null,
    } = {}) {
        if (!(target instanceof HTMLElement)) {
            throw new TypeError('ThinkingOrb target must be an HTMLElement.');
        }
        if (!STATE_PRESETS[state]) {
            throw new RangeError(`Unsupported thinking orb state: ${state}`);
        }

        this.target = target;
        this.state = state;
        this.size = Math.max(24, Number(size) || 64);
        this.displaySize = Math.max(1, Number(displaySize) || this.size);
        this.speed = Math.max(0.01, Number(speed) || 0.25);
        this.paused = Boolean(paused);
        this.destroyed = false;
        this.isIntersecting = true;
        this.animationFrame = 0;
        this.lastPhase = 0.6;

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'thinking-orb-canvas';
        this.canvas.setAttribute('role', 'img');
        this.canvas.setAttribute('aria-label', ariaLabel || STATE_PRESETS[state].label);
        this.canvas.style.width = `${this.displaySize}px`;
        this.canvas.style.height = `${this.displaySize}px`;
        this.target.replaceChildren(this.canvas);

        this.context = this.canvas.getContext('2d', { alpha: true });
        if (!this.context) {
            throw new Error('Canvas 2D is unavailable for ThinkingOrb.');
        }

        this.handleIntersection = this.handleIntersection.bind(this);
        this.animate = this.animate.bind(this);

        this.intersectionObserver = typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(this.handleIntersection, { rootMargin: '80px' })
            : null;
        this.intersectionObserver?.observe(this.canvas);

        this.resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => this.resizeCanvas())
            : null;
        this.resizeObserver?.observe(this.target);

        liveOrbs.add(this);
        ensureSharedLifecycle();
        this.resizeCanvas();
        this.draw(this.lastPhase);
        this.syncAnimation();
    }

    resizeCanvas() {
        if (this.destroyed) return;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const backingSize = Math.round(this.size * pixelRatio);
        if (this.canvas.width !== backingSize || this.canvas.height !== backingSize) {
            this.canvas.width = backingSize;
            this.canvas.height = backingSize;
        }
        this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        this.draw(this.lastPhase);
    }

    handleIntersection(entries) {
        const entry = entries[entries.length - 1];
        this.isIntersecting = Boolean(entry?.isIntersecting);
        this.syncAnimation();
    }

    shouldAnimate() {
        return !this.destroyed
            && !this.paused
            && !reducedMotionQuery.matches
            && this.isIntersecting
            && !document.hidden
            && this.canvas.isConnected;
    }

    draw(phase) {
        if (this.destroyed) return;
        const resolvedPhase = reducedMotionQuery.matches ? 0.6 : phase;
        this.lastPhase = resolvedPhase;
        STATE_PRESETS[this.state].draw(
            this.context,
            this.size,
            resolvedPhase,
            resolveDarkMode(this.target),
        );
    }

    animate(timestamp) {
        this.animationFrame = 0;
        if (!this.shouldAnimate()) return;
        const phase = (timestamp / 1000) * STATE_PRESETS[this.state].baseSpeed * this.speed;
        this.draw(phase);
        this.animationFrame = requestAnimationFrame(this.animate);
    }

    syncAnimation() {
        if (this.shouldAnimate()) {
            if (!this.animationFrame) {
                this.animationFrame = requestAnimationFrame(this.animate);
            }
        } else if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = 0;
        }
    }

    setPaused(paused) {
        this.paused = Boolean(paused);
        this.syncAnimation();
    }

    setState(state) {
        if (!STATE_PRESETS[state]) {
            throw new RangeError(`Unsupported thinking orb state: ${state}`);
        }
        this.state = state;
        this.canvas.setAttribute('aria-label', STATE_PRESETS[state].label);
        this.draw(this.lastPhase);
        this.syncAnimation();
    }

    refresh() {
        this.resizeCanvas();
        this.draw(this.lastPhase);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = 0;
        this.intersectionObserver?.disconnect();
        this.resizeObserver?.disconnect();
        mountedOrbs.delete(this.target);
        liveOrbs.delete(this);
        releaseSharedLifecycle();
    }
}

export function mountThinkingOrb(target, options = {}) {
    const existing = mountedOrbs.get(target);
    existing?.destroy();
    const orb = new ThinkingOrb(target, options);
    mountedOrbs.set(target, orb);
    return orb;
}

export function mountThinkingOrbs(root = document, options = {}) {
    const mounts = [
        ...(root instanceof HTMLElement && root.matches('[data-thinking-orb]') ? [root] : []),
        ...root.querySelectorAll('[data-thinking-orb]'),
    ];
    return mounts.map((target) => (
        mountedOrbs.get(target) || mountThinkingOrb(target, options)
    ));
}

export function setThinkingOrbsPaused(root = document, paused = true) {
    const mounts = [
        ...(root instanceof HTMLElement && root.matches('[data-thinking-orb]') ? [root] : []),
        ...root.querySelectorAll('[data-thinking-orb]'),
    ];
    mounts.forEach((target) => mountedOrbs.get(target)?.setPaused(paused));
}

export function destroyThinkingOrbs(root = document) {
    const mounts = [
        ...(root instanceof HTMLElement && root.matches('[data-thinking-orb]') ? [root] : []),
        ...root.querySelectorAll('[data-thinking-orb]'),
    ];
    mounts.forEach((target) => mountedOrbs.get(target)?.destroy());
}
