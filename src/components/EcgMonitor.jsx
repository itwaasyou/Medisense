import { useEffect, useRef } from "react";

/* ---------- constants: adjust to your hardware ---------- */
const FS = 250;                 // must match ECG_FS on the ESP32
const ADC_MV_PER_LSB = 0.125;   // ADS1115 GAIN_ONE (±4.096 V)
const FRONTEND_GAIN = 1100;     // AD8232 module. Change if yours differs
const MAINS_HZ = 50;            // India
const WINDOW_SEC = 6;           // seconds on screen
const TARGET_LATENCY_SEC = 2;   // playback buffer (smooths 1 s network batches)
const SWEEP_GAP_SEC = 0.15;     // blank gap ahead of the sweep line

/* ---------- biquad filters (RBJ cookbook) ---------- */
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
    makeBiquad("hp", 0.5, 0.707),
    makeBiquad("notch", MAINS_HZ, 30),
    makeBiquad("lp", 40, 0.707),
];

function runChain(chain, x) {
    for (const f of chain) x = f.process(x);
    return x;
}

function primeChain(chain, x) {            // settle filters on first sample, avoids a start-up spike
    for (let i = 0; i < 2000; i++) runChain(chain, x);
}

function decodeEcg(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true); // little-endian
    return out;
}

/* ---------- component ---------- */
/**
 * vitals: { ecgB64, ecgSeq, ecgN, leadsOff }
 * zoom: vertical zoom (1 = 3 mV full scale)
 */
export default function EcgMonitor({ vitals, zoom = 1, height = 220, color = "#10ff8a" }) {
    const canvasRef = useRef(null);
    const propsRef = useRef({ zoom, color });
    propsRef.current = { zoom, color };

    const N = FS * WINDOW_SEC;
    const st = useRef({
        queue: [], qHead: 0, nextSeq: null, needPrime: true, playing: false, dropped: 0,
        chain: makeChain(),
        buf: new Float32Array(N).fill(NaN), head: 0,
    });

    /* ---- ingest each new batch ---- */
    useEffect(() => {
        if (!vitals?.ecgB64) return;
        const s = st.current;
        const seq = Number(vitals.ecgSeq);
        if (s.nextSeq !== null && seq < s.nextSeq - Number(vitals.ecgN)) {
            // device rebooted (sequence restarted) -> reset everything
            s.queue = []; s.qHead = 0; s.nextSeq = null; s.playing = false;
            s.buf.fill(NaN); s.head = 0; s.needPrime = true;
        }
        if (s.nextSeq !== null && seq + Number(vitals.ecgN) <= s.nextSeq) return; // duplicate snapshot
        if (s.nextSeq !== null && seq > s.nextSeq) {
            s.dropped += seq - s.nextSeq;       // samples lost between device and browser
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
            const mv = (raw * ADC_MV_PER_LSB) / FRONTEND_GAIN;      // ADC counts -> electrode mV
            if (s.needPrime) { primeChain(s.chain, mv); s.needPrime = false; }
            s.buf[s.head] = runChain(s.chain, mv);
            s.head = (s.head + 1) % N;
        };

        const draw = () => {
            const s = st.current;
            const { zoom, color } = propsRef.current;
            const dpr = window.devicePixelRatio || 1;
            const w = cvs.clientWidth, h = cvs.clientHeight;
            if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
                cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const mvRange = 3 / zoom;                 // full height in mV
            const pxPerMv = h / mvRange;
            const pxPerSec = w / WINDOW_SEC;

            // ECG paper grid: 0.04 s / 0.1 mV small, 0.2 s / 0.5 mV large
            const grid = (stepPx, alpha, vertical) => {
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

            // waveform (linear segments only, so R peaks stay sharp)
            const gap = Math.floor(SWEEP_GAP_SEC * FS);
            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round";
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < N; i++) {
                const ahead = (i - s.head + N) % N < gap;
                const v = s.buf[i];
                if (ahead || Number.isNaN(v) || i === 0) pen = false;
                if (ahead || Number.isNaN(v)) continue;
                const x = (i / N) * w;
                const y = h / 2 - v * pxPerMv;
                if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        const tick = (t) => {
            const s = st.current;
            const dt = Math.min((t - last) / 1000, 0.25);
            last = t;

            const qLen = s.queue.length - s.qHead;
            if (!s.playing && qLen >= TARGET_LATENCY_SEC * FS) s.playing = true;

            if (s.playing) {
                // gently speed up / slow down to hold the target buffer
                const err = qLen / FS - TARGET_LATENCY_SEC;
                const rate = 1 + Math.max(-0.1, Math.min(0.2, err * 0.05));
                acc += dt * FS * rate;
                let n = Math.floor(acc);
                acc -= n;
                while (n-- > 0 && s.qHead < s.queue.length) pushSample(s.queue[s.qHead++]);
                if (s.qHead >= s.queue.length) s.playing = false;   // starved: rebuffer
                if (s.qHead > 4000) { s.queue = s.queue.slice(s.qHead); s.qHead = 0; }
            }

            draw();
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
                    background: "rgba(0,0,0,0.45)",
                }}>
                    LEADS OFF
                </div>
            )}
        </div>
    );
}