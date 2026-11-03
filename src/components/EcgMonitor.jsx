import { useEffect, useRef } from "react";

/* ---------- constants ---------- */
const FS = 250;                 // must match ECG_FS on the ESP32
const ADC_MV_PER_LSB = 0.125;   // ADS1115 GAIN_ONE
const FRONTEND_GAIN = 1100;     // AD8232 module
const MAINS_HZ = 50;
const WINDOW_SEC = 6;
const TARGET_LATENCY_SEC = 2;
const SWEEP_GAP_SEC = 0.15;

const MIN_SPAN_MV = 0.2;        // never zoom in tighter than this (avoids amplifying noise)
const FILL = 0.8;               // signal uses about 80% of the height
const SMOOTH = true;            // light 3-point smoothing of the drawn line

/* ---------- biquad filters ---------- */
class Biquad {
    constructor(b0, b1, b2, a0, a1, a2) {
        this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
        this.a1 = a1 / a0; this.a2 = a2 / a0;
        this.z1 = 0; this.z2 = 0;
    }
    process(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }
}

function makeBiquad(type, f0, Q) {
    const w0 = (2 * Math.PI * f0) / FS;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    if (type === "hp") return new Biquad((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, a0, a1, a2);
    if (type === "lp") return new Biquad((1 - cos) / 2, 1 - cos, (1 - cos) / 2, a0, a1, a2);
    return new Biquad(1, -2 * cos, 1, a0, a1, a2); // notch
}

const makeChain = () => [
    makeBiquad("hp", 0.67, 0.707),
    makeBiquad("notch", MAINS_HZ, 30),
    makeBiquad("lp", 40, 0.707),
];

function runChain(chain, x) {
    for (const f of chain) x = f.process(x);
    return x;
}

function primeChain(chain, x) {
    for (let i = 0; i < 2000; i++) runChain(chain, x);
}

function decodeEcg(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
    return out;
}

/* ---------- component ---------- */
/**
 * vitals: { ecgB64, ecgSeq, ecgN, leadsOff }
 * zoom:   multiplies the auto scale (1 = auto fit)
 * invert: flip the trace if R waves point downward
 */
export default function EcgMonitor({
    vitals, zoom = 1, height = 220, color = "#10ff8a", invert = false,
}) {
    const canvasRef = useRef(null);
    const propsRef = useRef({ zoom, color, invert });
    propsRef.current = { zoom, color, invert };

    const N = FS * WINDOW_SEC;
    const st = useRef({
        queue: [], qHead: 0, nextSeq: null, needPrime: true, playing: false, dropped: 0,
        chain: makeChain(),
        buf: new Float32Array(N).fill(NaN), head: 0,
        view: { mid: 0, span: 1.5 },     // smoothed auto-scale state
        lastScale: 0,
    });

    /* ---- ingest each new batch ---- */
    useEffect(() => {
        if (!vitals?.ecgB64) return;
        const s = st.current;
        const seq = Number(vitals.ecgSeq);
        if (s.nextSeq !== null && seq < s.nextSeq - Number(vitals.ecgN)) {
            s.queue = []; s.qHead = 0; s.nextSeq = null; s.playing = false;
            s.buf.fill(NaN); s.head = 0; s.needPrime = true;
        }
        if (s.nextSeq !== null && seq + Number(vitals.ecgN) <= s.nextSeq) return;
        if (s.nextSeq !== null && seq > s.nextSeq) {
            s.dropped += seq - s.nextSeq;
            s.needPrime = true;
        }
        const samples = decodeEcg(vitals.ecgB64);
        for (let i = 0; i < samples.length; i++) s.queue.push(samples[i]);
        s.nextSeq = seq + samples.length;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vitals?.ecgSeq, vitals?.ecgB64]);

    /* ---- playback + drawing loop ---- */
    useEffect(() => {
        const cvs = canvasRef.current;
        const ctx = cvs.getContext("2d");
        let raf, last = performance.now(), acc = 0;

        const pushSample = (raw) => {
            const s = st.current;
            const mv = (raw * ADC_MV_PER_LSB) / FRONTEND_GAIN;
            if (s.needPrime) { primeChain(s.chain, mv); s.needPrime = false; }
            s.buf[s.head] = runChain(s.chain, mv);
            s.head = (s.head + 1) % N;
        };

        // Update the auto scale from the visible window (robust: ignores the top/bottom 2%)
        const updateView = (now) => {
            const s = st.current;
            if (now - s.lastScale < 150) return;
            s.lastScale = now;

            const vals = [];
            for (let i = 0; i < N; i++) {
                const v = s.buf[i];
                if (!Number.isNaN(v)) vals.push(v);
            }
            if (vals.length < FS) return;           // wait for ~1 s of data
            vals.sort((a, b) => a - b);
            const lo = vals[Math.floor(vals.length * 0.02)];
            const hi = vals[Math.floor(vals.length * 0.98)];
            const med = vals[Math.floor(vals.length * 0.5)];

            const targetMid = (lo + hi) / 2 * 0.5 + med * 0.5;   // between centre of range and median
            const targetSpan = Math.max(hi - lo, MIN_SPAN_MV) / FILL;

            const v = s.view;
            // grow fast (signal got bigger), shrink slowly (signal got smaller)
            v.span += (targetSpan - v.span) * (targetSpan > v.span ? 0.5 : 0.06);
            v.mid += (targetMid - v.mid) * 0.1;
        };

        const draw = (now) => {
            const s = st.current;
            const { zoom, color, invert } = propsRef.current;
            updateView(now);

            const dpr = window.devicePixelRatio || 1;
            const w = cvs.clientWidth, h = cvs.clientHeight;
            if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
                cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const mvRange = s.view.span / zoom;       // full height in mV
            const pxPerMv = h / mvRange;
            const pxPerSec = w / WINDOW_SEC;
            const sign = invert ? -1 : 1;

            // ECG paper grid
            const grid = (stepPx, alpha, vertical) => {
                if (stepPx < 3) return;                 // too dense to be useful
                ctx.strokeStyle = `rgba(16,255,138,${alpha})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                const max = vertical ? w : h;
                for (let p = 0; p <= max; p += stepPx) {
                    if (vertical) { ctx.moveTo(p, 0); ctx.lineTo(p, h); }
                    else { ctx.moveTo(0, p); ctx.lineTo(w, p); }
                }
                ctx.stroke();
            };
            grid(pxPerSec * 0.04, 0.05, true); grid(pxPerMv * 0.1, 0.05, false);
            grid(pxPerSec * 0.2, 0.14, true); grid(pxPerMv * 0.5, 0.14, false);

            // waveform
            const gap = Math.floor(SWEEP_GAP_SEC * FS);
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();   // never draw outside the box
            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < N; i++) {
                const ahead = (i - s.head + N) % N < gap;
                let v = s.buf[i];
                if (ahead || Number.isNaN(v) || i === 0) pen = false;
                if (ahead || Number.isNaN(v)) continue;

                if (SMOOTH) {
                    const a = s.buf[(i - 1 + N) % N], b = s.buf[(i + 1) % N];
                    if (!Number.isNaN(a) && !Number.isNaN(b)) v = (a + 2 * v + b) / 4;
                }
                const x = (i / N) * w;
                const y = h / 2 - sign * (v - s.view.mid) * pxPerMv;
                if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();

            // scale label
            ctx.fillStyle = "rgba(16,255,138,0.6)";
            ctx.font = "10px monospace";
            ctx.fillText(`${mvRange.toFixed(2)} mV full scale`, 8, h - 8);
        };

        const tick = (t) => {
            const s = st.current;
            const dt = Math.min((t - last) / 1000, 0.25);
            last = t;

            const qLen = s.queue.length - s.qHead;
            if (!s.playing && qLen >= TARGET_LATENCY_SEC * FS) s.playing = true;

            if (s.playing) {
                const err = qLen / FS - TARGET_LATENCY_SEC;
                const rate = 1 + Math.max(-0.1, Math.min(0.2, err * 0.05));
                acc += dt * FS * rate;
                let n = Math.floor(acc);
                acc -= n;
                while (n-- > 0 && s.qHead < s.queue.length) pushSample(s.queue[s.qHead++]);
                if (s.qHead >= s.queue.length) s.playing = false;
                if (s.qHead > 4000) { s.queue = s.queue.slice(s.qHead); s.qHead = 0; }
            }

            draw(t);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [N]);

    return (
        <div style={{ position: "relative", width: "100%", height }}>
            <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
            {vitals?.leadsOff && (
                <div style={{
                    position: "absolute", inset: 0, display: "flex", alignItems: "center",
                    justifyContent: "center", color: "#ff2d2d", fontWeight: 700, letterSpacing: 2,
                    background: "rgba(0,0,0,0.15)",
                }}>
                    LEADS OFF
                </div>
            )}
        </div>
    );
}