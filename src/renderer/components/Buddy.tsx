import { useEffect, useMemo, useRef } from "react";
import type { AgentView, Mood } from "../../shared/types.js";
import { MOODS } from "../mood.js";

const SIZE = 230;
const CX = SIZE / 2;
const CY = SIZE / 2;
const BODY_W = 132;
const BODY_H = 118;
const BODY_X = CX - BODY_W / 2;
const BODY_Y = CY - BODY_H / 2;
const EYE_Y = CY - 10;
const EYE_DX = 20;
const MOUTH_Y = CY + 7;
const INK = "#292244";

interface FaceSpec {
    eyes: "open" | "happy" | "sleepy" | "sad";
    openness: number;
    mouth: "smile" | "smallO" | "openSmile" | "wobble" | "flat";
    mouthAmount: number;
    blush: number;
    /** Static pupil bias in eye-units, on top of cursor tracking. */
    bias: { x: number; y: number };
    tilt: number;
}

function faceFor(mood: Mood): FaceSpec {
    switch (mood) {
        case "napping":
            return { eyes: "sleepy", openness: 0, mouth: "smallO", mouthAmount: 0.5, blush: 0.3, bias: { x: 0, y: 0 }, tilt: -6 };
        case "idle":
            return { eyes: "open", openness: 1, mouth: "smile", mouthAmount: 0.75, blush: 0.42, bias: { x: 0, y: 0 }, tilt: 0 };
        case "listening":
            return { eyes: "open", openness: 1.18, mouth: "smallO", mouthAmount: 1, blush: 0.5, bias: { x: 0, y: 0.15 }, tilt: 3 };
        case "thinking":
            return { eyes: "open", openness: 0.85, mouth: "wobble", mouthAmount: 0.35, blush: 0.4, bias: { x: 0.4, y: -0.7 }, tilt: -8 };
        case "working":
            return { eyes: "open", openness: 0.66, mouth: "smile", mouthAmount: 0.35, blush: 0.55, bias: { x: 0, y: 0.25 }, tilt: 0 };
        case "needsInput":
            return { eyes: "open", openness: 1.3, mouth: "smallO", mouthAmount: 1, blush: 0.6, bias: { x: 0, y: 0 }, tilt: 0 };
        case "celebrating":
            return { eyes: "happy", openness: 0, mouth: "openSmile", mouthAmount: 1, blush: 0.7, bias: { x: 0, y: 0 }, tilt: 0 };
        case "broken":
            return { eyes: "sad", openness: 0.7, mouth: "wobble", mouthAmount: -0.4, blush: 0.15, bias: { x: 0, y: 0.3 }, tilt: -4 };
    }
}

export interface BuddyProps {
    mood: Mood;
    agents: AgentView[];
    blockedCount: number;
}

/**
 * The character. React renders the structure once per mood; a single rAF loop
 * then mutates transforms and paints the agent motes, so continuous animation
 * costs no React work at all.
 */
export function Buddy({ mood, agents, blockedCount }: BuddyProps): React.JSX.Element {
    const face = useMemo(() => faceFor(mood), [mood]);
    const palette = MOODS[mood];

    const rootRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<SVGGElement>(null);
    const antennaRef = useRef<SVGGElement>(null);
    const bulbGlowRef = useRef<SVGCircleElement>(null);
    const armLRef = useRef<SVGGElement>(null);
    const armRRef = useRef<SVGGElement>(null);
    const ringRef = useRef<SVGGElement>(null);
    const shadowRef = useRef<SVGEllipseElement>(null);
    const auraRef = useRef<SVGCircleElement>(null);
    const eyeLRef = useRef<SVGGElement>(null);
    const eyeRRef = useRef<SVGGElement>(null);
    const pupilLRef = useRef<SVGGElement>(null);
    const pupilRRef = useRef<SVGGElement>(null);
    const mouthRef = useRef<SVGGElement>(null);
    const backRef = useRef<HTMLCanvasElement>(null);
    const frontRef = useRef<HTMLCanvasElement>(null);
    const decorRef = useRef<SVGGElement>(null);

    const look = useRef({ x: 0, y: 0 });
    // Read inside the loop without re-subscribing every render.
    const live = useRef({ mood, face, agents, blockedCount });
    live.current = { mood, face, agents, blockedCount };

    useEffect(() => {
        const onMove = (event: MouseEvent): void => {
            const rect = rootRef.current?.getBoundingClientRect();
            if (!rect) return;
            const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
            const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
            look.current = {
                x: Math.max(-1.4, Math.min(1.4, dx)),
                y: Math.max(-1.4, Math.min(1.4, dy)),
            };
        };
        window.addEventListener("mousemove", onMove);
        return () => window.removeEventListener("mousemove", onMove);
    }, []);

    useEffect(() => {
        let raf = 0;
        let lastPaint = 0;
        const start = performance.now();

        const paint = (now: number): void => {
            raf = requestAnimationFrame(paint);

            const current = live.current;
            const interval =
                current.mood === "napping" ? 1000 / 12 : current.mood === "idle" ? 1000 / 24 : 1000 / 60;
            if (now - lastPaint < interval) return;
            lastPaint = now;

            const t = (now - start) / 1000;
            const tempo = MOODS[current.mood].tempo;
            const breath = Math.sin(t * 1.6 * tempo);
            const bob = breath * (current.mood === "napping" ? 3 : 5);
            const squashAmount = current.mood === "napping" ? 0.03 : 0.045;
            const sx = 1 - breath * squashAmount;
            const sy = 1 + breath * squashAmount;
            const tilt = current.face.tilt + wobbleFor(current.mood, t);

            // Body: squash about the base, then bob and tilt.
            setTransform(
                bodyRef.current,
                `translate(${CX} ${CY + BODY_H / 2}) rotate(${tilt * 0.5}) scale(${sx} ${sy}) translate(${-CX} ${-(CY + BODY_H / 2)}) translate(0 ${-bob})`,
            );

            const antennaWobble = Math.sin(t * 2.1 * tempo) * (current.mood === "napping" ? 4 : 9);
            setTransform(
                antennaRef.current,
                `rotate(${antennaWobble} ${CX} ${BODY_Y + 4})`,
            );
            const pulse = 0.5 + 0.5 * Math.sin(t * 3.4 * tempo);
            if (bulbGlowRef.current) {
                bulbGlowRef.current.setAttribute("r", String(9 + pulse * 7));
                bulbGlowRef.current.setAttribute("opacity", String(0.35 + pulse * 0.4));
            }

            const swing = Math.sin(t * 3 * tempo);
            const celebrating = current.mood === "celebrating";
            const armBase = celebrating ? -38 : current.mood === "working" ? -10 : 14;
            const armAmp = celebrating ? 22 : current.mood === "working" ? 22 : 5;
            setTransform(armLRef.current, `rotate(${armBase + swing * armAmp} ${CX - 62} ${CY + 6})`);
            setTransform(armRRef.current, `rotate(${-(armBase - swing * armAmp)} ${CX + 62} ${CY + 6})`);

            setTransform(ringRef.current, `rotate(${t * 42} ${CX} ${CY})`);
            if (auraRef.current) auraRef.current.setAttribute("r", String(105 * (1 + breath * 0.035)));
            if (shadowRef.current) {
                shadowRef.current.setAttribute("rx", String(55 + breath * 3));
                shadowRef.current.setAttribute("cy", String(CY + BODY_H * 0.6 - bob * 0.35));
            }

            // Eyes: deterministic blink, cursor-tracked pupils.
            const blink = blinkAt(t, current.mood);
            if (current.face.eyes === "open") {
                const scale = Math.max(0.06, current.face.openness * blink);
                setTransform(eyeLRef.current, `translate(0 ${EYE_Y}) scale(1 ${scale}) translate(0 ${-EYE_Y})`);
                setTransform(eyeRRef.current, `translate(0 ${EYE_Y}) scale(1 ${scale}) translate(0 ${-EYE_Y})`);
                const px = (look.current.x * 0.55 + current.face.bias.x) * 3.4;
                const py = (look.current.y * 0.45 + current.face.bias.y) * 2.8;
                setTransform(pupilLRef.current, `translate(${px} ${py})`);
                setTransform(pupilRRef.current, `translate(${px} ${py})`);
            }

            if (current.face.mouth === "smallO" && current.mood === "napping") {
                // Sleep bubble breathes with the body.
                const amount = 0.5 + 0.5 * Math.sin(t * 1.1);
                const ellipse = mouthRef.current?.firstElementChild as SVGEllipseElement | null;
                if (ellipse) {
                    ellipse.setAttribute("rx", String(3 + amount * 1.6));
                    ellipse.setAttribute("ry", String(3 + amount * 2.6));
                }
            }

            drawDecorations(decorRef.current, current.mood, t, palette.accent);
            drawMotes(backRef.current, "back", current.agents, t);
            drawMotes(frontRef.current, "front", current.agents, t);
            if (current.mood === "celebrating") drawConfetti(frontRef.current, t);
        };

        raf = requestAnimationFrame(paint);
        return () => cancelAnimationFrame(raf);
        // `palette.accent` is the only value the loop reads that React owns.
    }, [palette.accent]);

    const ringVisible = agents.length > 0 || mood === "working" || mood === "needsInput";

    return (
        <div className="buddy" ref={rootRef} style={{ width: SIZE, height: SIZE }}>
            <canvas className="buddy-fx" ref={backRef} width={SIZE * 2} height={SIZE * 2} />
            <svg className="buddy-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
                <defs>
                    <linearGradient id="bodyGrad" x1="0.1" y1="0" x2="0.9" y2="1">
                        <stop offset="0%" stopColor={palette.tint} />
                        <stop offset="48%" stopColor={palette.accent} />
                        <stop offset="100%" stopColor={shade(palette.accent, -0.24)} />
                    </linearGradient>
                    <linearGradient id="armGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={palette.accent} />
                        <stop offset="100%" stopColor={shade(palette.accent, -0.2)} />
                    </linearGradient>
                    <radialGradient id="bulbGlow">
                        <stop offset="0%" stopColor={palette.accent} stopOpacity="0.9" />
                        <stop offset="100%" stopColor={palette.accent} stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="auraGrad">
                        <stop offset="0%" stopColor={palette.accent} stopOpacity="0.36" />
                        <stop offset="100%" stopColor={palette.accent} stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="highlightGrad">
                        <stop offset="0%" stopColor="#fff" stopOpacity="0.52" />
                        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="shadowGrad">
                        <stop offset="0%" stopColor="#000" stopOpacity="0.34" />
                        <stop offset="100%" stopColor="#000" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="bulbGrad">
                        <stop offset="0%" stopColor="#fff" />
                        <stop offset="100%" stopColor={palette.accent} />
                    </radialGradient>
                    <filter id="soften" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="3" />
                    </filter>
                </defs>

                <circle ref={auraRef} cx={CX} cy={CY} r={105} fill="url(#auraGrad)" />

                <g ref={ringRef} opacity={ringVisible ? 0.8 : 0}>
                    <circle
                        cx={CX}
                        cy={CY}
                        r={84}
                        fill="none"
                        stroke={palette.accent}
                        strokeOpacity="0.5"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeDasharray="10 12"
                    />
                </g>

                <ellipse ref={shadowRef} cx={CX} cy={CY + BODY_H * 0.6} rx={55} ry={12} fill="url(#shadowGrad)" />

                <g ref={bodyRef}>
                    <g ref={antennaRef}>
                        <rect x={CX - 2} y={BODY_Y - 26} width={4} height={30} rx={2} fill={palette.accent} />
                        <circle ref={bulbGlowRef} cx={CX} cy={BODY_Y - 28} r={12} fill="url(#bulbGlow)" opacity="0.5" />
                        <circle cx={CX} cy={BODY_Y - 28} r={7.5} fill="url(#bulbGrad)" stroke="#fff" strokeOpacity="0.7" />
                    </g>

                    <g ref={armLRef}>
                        <rect x={CX - 70} y={CY + 4} width={15} height={31} rx={7.5} fill="url(#armGrad)" stroke="#fff" strokeOpacity="0.32" />
                    </g>
                    <g ref={armRRef}>
                        <rect x={CX + 55} y={CY + 4} width={15} height={31} rx={7.5} fill="url(#armGrad)" stroke="#fff" strokeOpacity="0.32" />
                    </g>

                    <rect
                        x={BODY_X}
                        y={BODY_Y}
                        width={BODY_W}
                        height={BODY_H}
                        rx={46}
                        ry={44}
                        fill="url(#bodyGrad)"
                        stroke="#fff"
                        strokeOpacity="0.5"
                        strokeWidth="1.4"
                    />
                    <ellipse cx={CX - 26} cy={BODY_Y + 27} rx={27} ry={18} fill="url(#highlightGrad)" />
                    <ellipse cx={CX} cy={BODY_Y + BODY_H - 12} rx={44} ry={14} fill="#fff" opacity="0.13" filter="url(#soften)" />

                    <ellipse cx={CX - 34} cy={EYE_Y + 14} rx={9} ry={5} fill="#FF8C9E" opacity={face.blush} filter="url(#soften)" />
                    <ellipse cx={CX + 34} cy={EYE_Y + 14} rx={9} ry={5} fill="#FF8C9E" opacity={face.blush} filter="url(#soften)" />

                    <Eye side="left" spec={face} groupRef={eyeLRef} pupilRef={pupilLRef} />
                    <Eye side="right" spec={face} groupRef={eyeRRef} pupilRef={pupilRRef} />

                    <g ref={mouthRef}>
                        <Mouth spec={face} />
                    </g>
                </g>

                <g ref={decorRef} />
            </svg>
            <canvas className="buddy-fx" ref={frontRef} width={SIZE * 2} height={SIZE * 2} />
            {blockedCount > 0 && <div className="buddy-badge">{blockedCount}</div>}
        </div>
    );
}

function Eye({
    side,
    spec,
    groupRef,
    pupilRef,
}: {
    side: "left" | "right";
    spec: FaceSpec;
    groupRef: React.RefObject<SVGGElement | null>;
    pupilRef: React.RefObject<SVGGElement | null>;
}): React.JSX.Element {
    const cx = side === "left" ? CX - EYE_DX : CX + EYE_DX;

    if (spec.eyes === "happy") {
        return (
            <path
                d={`M ${cx - 9} ${EYE_Y + 3} Q ${cx} ${EYE_Y - 9} ${cx + 9} ${EYE_Y + 3}`}
                fill="none"
                stroke={INK}
                strokeWidth="3.2"
                strokeLinecap="round"
            />
        );
    }
    if (spec.eyes === "sleepy") {
        return (
            <path
                d={`M ${cx - 9} ${EYE_Y - 2} Q ${cx} ${EYE_Y + 7} ${cx + 9} ${EYE_Y - 2}`}
                fill="none"
                stroke={INK}
                strokeOpacity="0.85"
                strokeWidth="3"
                strokeLinecap="round"
            />
        );
    }
    if (spec.eyes === "sad") {
        return (
            <g>
                <circle cx={cx} cy={EYE_Y + 2} r={6} fill={INK} opacity="0.75" />
                <path
                    d={`M ${cx - 9} ${EYE_Y - 8} L ${cx + 8} ${EYE_Y - 4}`}
                    stroke={INK}
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    transform={side === "right" ? `scale(-1 1) translate(${-2 * cx} 0)` : undefined}
                />
            </g>
        );
    }

    return (
        <g ref={groupRef}>
            <g ref={pupilRef}>
                <rect x={cx - 8} y={EYE_Y - 10} width={16} height={20} rx={8} fill={INK} />
                <circle cx={cx - 2.4} cy={EYE_Y - 4} r={2.7} fill="#fff" opacity="0.95" />
                <circle cx={cx + 3} cy={EYE_Y + 4} r={1.4} fill="#fff" opacity="0.5" />
            </g>
        </g>
    );
}

function Mouth({ spec }: { spec: FaceSpec }): React.JSX.Element {
    switch (spec.mouth) {
        case "smallO":
            return <ellipse cx={CX} cy={MOUTH_Y} rx={4} ry={5} fill={INK} />;
        case "openSmile":
            return (
                <g>
                    <path
                        d={`M ${CX - 13} ${MOUTH_Y - 4} Q ${CX} ${MOUTH_Y + 14} ${CX + 13} ${MOUTH_Y - 4} Z`}
                        fill={INK}
                    />
                    <ellipse cx={CX} cy={MOUTH_Y + 4} rx={6} ry={3.4} fill="#FF8C9E" />
                </g>
            );
        case "wobble":
            return (
                <path
                    d={`M ${CX - 8} ${MOUTH_Y} Q ${CX} ${MOUTH_Y + spec.mouthAmount * 10} ${CX + 8} ${MOUTH_Y}`}
                    fill="none"
                    stroke={INK}
                    strokeWidth="2.6"
                    strokeLinecap="round"
                />
            );
        case "flat":
            return <rect x={CX - 7} y={MOUTH_Y - 1.3} width={14} height={2.6} rx={1.3} fill={INK} />;
        default:
            return (
                <path
                    d={`M ${CX - 10} ${MOUTH_Y} Q ${CX} ${MOUTH_Y + spec.mouthAmount * 11} ${CX + 10} ${MOUTH_Y}`}
                    fill="none"
                    stroke={INK}
                    strokeWidth="2.8"
                    strokeLinecap="round"
                />
            );
    }
}

// MARK: - Animation helpers

function setTransform(element: SVGGraphicsElement | null, value: string): void {
    element?.setAttribute("transform", value);
}

function wobbleFor(mood: Mood, t: number): number {
    switch (mood) {
        case "idle":
            return Math.sin(t * 0.8) * 2.5;
        case "thinking":
            return Math.sin(t * 1.4) * 3;
        case "working":
            return Math.sin(t * 2.2) * 3.5;
        case "needsInput":
            return Math.sin(t * 6) * 5;
        case "celebrating":
            return Math.sin(t * 5) * 8;
        case "napping":
            return Math.sin(t * 0.5) * 2;
        default:
            return 0;
    }
}

function blinkAt(t: number, mood: Mood): number {
    const cycle = mood === "working" ? 2.4 : 3.8;
    const phase = t % cycle;
    if (phase < 0.09) return Math.max(0.05, phase / 0.09);
    if (phase < 0.18) return Math.max(0.05, (0.18 - phase) / 0.09);
    if (phase > 0.3 && phase < 0.38) return 0.25;
    return 1;
}

/** Orbiting agent motes. The near half of the ring passes below the chin. */
function drawMotes(
    canvas: HTMLCanvasElement | null,
    layer: "back" | "front",
    agents: AgentView[],
    t: number,
): void {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (agents.length === 0) return;

    const centerY = CY + 34;
    const rx = SIZE * 0.44;
    const ry = rx * 0.4;

    agents.forEach((agent, index) => {
        const speed = 0.55 + (index % 3) * 0.16;
        const lift = -(index % 3) * 8;
        const spread = agents.length > 1 ? (index / agents.length) * Math.PI * 2 : 0;
        const phase = agent.hue * 1.5 + spread;
        const angle = phase + t * speed;
        const depth = Math.sin(angle);
        if (layer === "front" ? depth < 0 : depth >= 0) return;

        const wobble = Math.sin(t * 1.4 + index) * 6;
        const x = CX + Math.cos(angle) * (rx + wobble);
        const y = centerY + Math.sin(angle) * (ry + wobble * 0.4) + lift;
        const blocked = agent.status === "needs-input";
        const pulse = blocked ? 0.55 + 0.45 * Math.sin(t * 8) : 1;
        const depthScale = 0.72 + ((depth + 1) / 2) * 0.5;
        const radius = 6.5 * depthScale * (blocked ? 1.25 : 1);
        const color = blocked ? "#FF6B78" : `hsl(${Math.round(agent.hue * 360)} 72% 66%)`;

        for (let step = 5; step >= 1; step -= 1) {
            const trailAngle = phase + (t - step * 0.09) * speed;
            const tx = CX + Math.cos(trailAngle) * rx;
            const ty = centerY + Math.sin(trailAngle) * ry + lift;
            ctx.globalAlpha = 0.14 * (1 - step / 6) * depthScale;
            ctx.beginPath();
            ctx.arc(tx, ty, radius * (1 - step * 0.14), 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }

        ctx.globalAlpha = 1;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.2);
        glow.addColorStop(0, hexWithAlpha(color, 0.42 * pulse));
        glow.addColorStop(1, hexWithAlpha(color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();

        // Activity ticks instead of a fake percentage: one arc per tool call,
        // wrapping every twelve, so a busy agent visibly spins up.
        const ticks = Math.min(12, agent.toolCalls % 12 || (agent.toolCalls > 0 ? 12 : 0));
        if (ticks > 0) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 4, -Math.PI / 2, -Math.PI / 2 + (ticks / 12) * Math.PI * 2);
            ctx.strokeStyle = hexWithAlpha(color, 0.9);
            ctx.lineWidth = 2;
            ctx.lineCap = "round";
            ctx.stroke();
        }
    });
    ctx.globalAlpha = 1;
}

function drawConfetti(canvas: HTMLCanvasElement | null, t: number): void {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    for (let index = 0; index < 26; index += 1) {
        const seed = index * 12.9898;
        const angle = seed % (Math.PI * 2);
        const speed = 60 + ((seed * 7) % 55);
        const lifeSpan = (t * 0.9 + index * 0.11) % 1;
        const distance = 46 + lifeSpan * speed;
        const x = CX + Math.cos(angle) * distance;
        const y = CY + Math.sin(angle) * distance - lifeSpan * 22 + 20;
        const side = 4 + ((seed * 3) % 4);
        ctx.globalAlpha = Math.sin(lifeSpan * Math.PI);
        ctx.fillStyle = `hsl(${Math.round(((seed * 0.37) % 1) * 360)} 80% 62%)`;
        ctx.fillRect(x, y, side, side * 1.7);
    }
    ctx.globalAlpha = 1;
}

/** Mood-specific flourishes, rebuilt each frame into a single SVG group. */
function drawDecorations(group: SVGGElement | null, mood: Mood, t: number, accent: string): void {
    if (!group) return;
    const ns = "http://www.w3.org/2000/svg";
    const want = decorationSpec(mood, t, accent);
    if (group.childElementCount !== want.length) {
        group.replaceChildren(
            ...want.map((spec) => document.createElementNS(ns, spec.tag) as SVGElement),
        );
    }
    want.forEach((spec, index) => {
        const node = group.children[index] as SVGElement | undefined;
        if (!node) return;
        if (node.tagName !== spec.tag) return;
        for (const [key, value] of Object.entries(spec.attrs)) {
            node.setAttribute(key, String(value));
        }
        if (spec.text !== undefined) node.textContent = spec.text;
    });
}

interface DecorSpec {
    tag: string;
    attrs: Record<string, string | number>;
    text?: string;
}

function decorationSpec(mood: Mood, t: number, accent: string): DecorSpec[] {
    if (mood === "napping") {
        return [0, 1, 2].map((index) => {
            const phase = (t * 0.42 + index * 0.33) % 1;
            return {
                tag: "text",
                text: "z",
                attrs: {
                    x: CX + 46 + Math.sin(phase * Math.PI * 2) * 8 + phase * 12,
                    y: CY - 46 - phase * 42,
                    "font-size": 14 + index * 5,
                    "font-weight": 800,
                    fill: "#ffffff",
                    opacity: Math.sin(phase * Math.PI).toFixed(3),
                },
            };
        });
    }
    if (mood === "needsInput") {
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        return [
            {
                tag: "circle",
                attrs: { cx: CX + 52, cy: CY - 52, r: 15 + pulse * 2, fill: accent },
            },
            {
                tag: "text",
                text: "!",
                attrs: {
                    x: CX + 52,
                    y: CY - 45,
                    "font-size": 19,
                    "font-weight": 900,
                    fill: "#fff",
                    "text-anchor": "middle",
                },
            },
        ];
    }
    if (mood === "thinking") {
        return [0, 1, 2].map((index) => ({
            tag: "circle",
            attrs: {
                cx: CX + 44 + index * 11,
                cy: CY - 54,
                r: 3 + Math.max(0, Math.sin(t * 4 - index * 0.7)) * 2,
                fill: "#fff",
                opacity: 0.9,
            },
        }));
    }
    if (mood === "working") {
        const phase = (t * 0.7) % 1;
        return [
            {
                tag: "ellipse",
                attrs: {
                    cx: CX - 58,
                    cy: CY - 44 + phase * 24,
                    rx: 6,
                    ry: 8,
                    fill: "#7FD0FF",
                    stroke: "#ffffff",
                    "stroke-opacity": 0.7,
                    opacity: (1 - phase).toFixed(3),
                },
            },
        ];
    }
    return [];
}

/** Darken (negative) or lighten (positive) a hex colour. */
function shade(hex: string, amount: number): string {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    const mixed = channels.map((channel) => {
        const target = amount < 0 ? 0 : 255;
        return Math.round(channel + (target - channel) * Math.abs(amount));
    });
    return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function hexWithAlpha(color: string, alpha: number): string {
    if (color.startsWith("hsl")) return color.replace("hsl(", "hsla(").replace(")", ` / ${alpha})`);
    const value = color.replace("#", "");
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
