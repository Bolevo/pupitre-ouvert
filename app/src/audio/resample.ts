// High-quality pitch shifting, done once per note and kept in memory (RAM rather than CPU):
// windowed-sinc (Lanczos) resampling, anti-aliased when shifting up, with a seamless loop.
// The browser's own playbackRate uses linear interpolation, which sounds grainy and metallic.
// Pure functions (run in resample.worker.ts; testable without a worker).

export interface ResampleJob {
  id: number;
  data: Float32Array; // source PCM at the output sample rate
  ratio: number; // source samples advanced per output sample (> 1 = higher pitch)
  loopStart: number; // source samples; -1 = no loop
  loopEnd: number;
  maxOut: number; // longest output wanted (samples), for unlooped sounds
}
export interface ResampleResult {
  id: number;
  out: Float32Array;
  loopStart: number; // output samples (-1 = no loop)
  loopEnd: number;
}

const A = 8; // Lanczos lobes: 2A taps at unit cutoff

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -A || x >= A) return 0;
  const px = Math.PI * x;
  return (A * Math.sin(px) * Math.sin(px / A)) / (px * px);
}
// tabulated kernel (no trigonometry in the inner loop)
const RES = 2048;
const TABLE = new Float32Array(A * RES + 2);
for (let i = 0; i < TABLE.length; i++) TABLE[i] = lanczos(i / RES);

/** Fills out[k] = src(start + k * step) for k in [0, n), windowed-sinc, no bounds surprises:
 *  `src` must hold `half` samples of margin on both sides of the positions read (zeros outside). */
function run(src: Float32Array, start: number, step: number, n: number, cutoff: number, out: Float32Array, o0: number) {
  const half = Math.ceil(A / cutoff);
  const scale = cutoff * RES;
  const lim = A * RES;
  for (let k = 0; k < n; k++) {
    const pos = start + k * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    let acc = 0;
    let norm = 0;
    const lo = i0 - half + 1;
    for (let i = lo; i <= i0 + half; i++) {
      let t = (frac - (i - i0)) * scale;
      if (t < 0) t = -t;
      const ti = t | 0;
      if (ti >= lim) continue;
      const w = TABLE[ti];
      norm += w;
      if (i >= 0 && i < src.length) acc += src[i] * w;
    }
    out[o0 + k] = norm ? acc / norm : 0;
  }
}

export function resample(job: ResampleJob): ResampleResult {
  const { data, ratio, loopStart: ls, loopEnd: le } = job;
  const cutoff = Math.min(1, 1 / ratio);
  if (ratio === 1 && ls < 0) {
    const out = data.slice(0, Math.min(job.maxOut, data.length));
    return { id: job.id, out, loopStart: -1, loopEnd: -1 };
  }
  if (ls < 0 || le - ls < 64) {
    const n = Math.min(job.maxOut, Math.floor(data.length / ratio));
    const out = new Float32Array(n);
    run(data, 0, ratio, n, cutoff, out, 0);
    return { id: job.id, out, loopStart: -1, loopEnd: -1 };
  }
  const half = Math.ceil(A / cutoff) + 2;
  const L = le - ls;
  // attack: the sample up to the loop start, the loop continuing after it (as it will be heard)
  const ext = new Float32Array(le + 2 * half);
  ext.set(data.subarray(0, le));
  for (let i = 0; i < 2 * half; i++) ext[le + i] = data[ls + (i % L)];
  // loop: strictly periodic on both sides, so its last output sample flows into its first one
  const per = new Float32Array(L + 2 * half);
  for (let i = 0; i < per.length; i++) per[i] = data[ls + ((((i - half) % L) + L) % L)];
  // attack up to the loop, then exactly one loop period: a whole number of output samples, so the
  // loop restarts without a seam (the pitch inside the loop moves by far less than a cent)
  const attackOut = Math.round(ls / ratio);
  const loopOut = Math.max(64, Math.round(L / ratio));
  const out = new Float32Array(attackOut + loopOut);
  run(ext, 0, ls / Math.max(1, attackOut), attackOut, cutoff, out, 0);
  run(per, half, L / loopOut, loopOut, cutoff, out, attackOut);
  return { id: job.id, out, loopStart: attackOut, loopEnd: attackOut + loopOut };
}

