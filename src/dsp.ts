/**
 * DSP primitives. Everything is plain Float32Array maths so the exact same
 * code renders in Node and in the browser, with no Web Audio dependency.
 */

/* ------------------------------------------------------------ oscillators */

/**
 * polyBLEP: a 2-sample correction applied around a waveform's discontinuities.
 * Naive saw/square alias badly (you hear a metallic ring on high notes); this
 * removes most of it for a handful of multiply-adds per sample.
 */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export type Waveform = 'sine' | 'triangle' | 'saw' | 'square' | 'noise';

/** Stateless-per-call oscillator sample. `phase` in 0..1, `dt` = freq / sampleRate. */
export function oscillator(wave: Waveform, phase: number, dt: number, rand: () => number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'triangle': {
      // Integrated square would be exact; this cheap form is clean enough and
      // triangles alias far less than saws to begin with.
      const t = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
      return t;
    }
    case 'saw':
      return 2 * phase - 1 - polyBlep(phase, dt);
    case 'square': {
      const naive = phase < 0.5 ? 1 : -1;
      return naive - polyBlep(phase, dt) + polyBlep((phase + 0.5) % 1, dt);
    }
    case 'noise':
      return rand() * 2 - 1;
  }
}

/* ------------------------------------------------------------- envelopes */

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/**
 * ADSR value at time `t` seconds after note-on, where the note is held for
 * `hold` seconds. Exponential-ish curves (x^1.6 / x^2) sound more natural than
 * straight lines.
 */
export function adsrValue(env: Adsr, t: number, hold: number): number {
  if (t < 0) return 0;
  if (t < env.attack) {
    const x = env.attack <= 0 ? 1 : t / env.attack;
    return x * x * (3 - 2 * x); // smoothstep attack: no click, no sluggishness
  }
  const afterAttack = t - env.attack;
  if (t < hold) {
    if (afterAttack < env.decay) {
      const x = env.decay <= 0 ? 1 : afterAttack / env.decay;
      return 1 + (env.sustain - 1) * (x * x);
    }
    return env.sustain;
  }
  const levelAtRelease = (() => {
    const a = hold - env.attack;
    if (a < 0) return Math.min(1, hold / Math.max(1e-6, env.attack));
    if (a < env.decay) {
      const x = env.decay <= 0 ? 1 : a / env.decay;
      return 1 + (env.sustain - 1) * (x * x);
    }
    return env.sustain;
  })();
  const r = t - hold;
  if (r >= env.release) return 0;
  const x = 1 - r / Math.max(1e-6, env.release);
  return levelAtRelease * x * x;
}

export function envDuration(env: Adsr, hold: number): number {
  return hold + env.release;
}

/* ---------------------------------------------------------------- filter */

/** Direct-form-I resonant biquad (RBJ cookbook). Low-pass and high-pass. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly sampleRate: number) {}

  setLowpass(freq: number, q: number): void {
    const f = clamp(freq, 20, this.sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / this.sampleRate;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setHighpass(freq: number, q: number): void {
    const f = clamp(freq, 10, this.sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / this.sampleRate;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = ((1 + cw) / 2) / a0;
    this.b1 = (-(1 + cw)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setBandpass(freq: number, q: number): void {
    const f = clamp(freq, 20, this.sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / this.sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** One-pole low-pass, used for cheap damping inside the reverb. */
export class OnePole {
  private z = 0;
  private a = 0.5;
  setCoefficient(a: number): void {
    this.a = clamp(a, 0, 0.999);
  }
  process(x: number): number {
    this.z = x * (1 - this.a) + this.z * this.a;
    return this.z;
  }
}

/* ------------------------------------------------------------------ delay */

/** Stereo delay with feedback and a damped repeat tail. */
export class StereoDelay {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private idx = 0;
  private dampL = new OnePole();
  private dampR = new OnePole();

  constructor(private readonly size: number, private readonly feedback: number, damping = 0.35) {
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.dampL.setCoefficient(damping);
    this.dampR.setCoefficient(damping);
  }

  process(l: number, r: number, out: [number, number]): void {
    const dl = this.bufL[this.idx]!;
    const dr = this.bufR[this.idx]!;
    // Cross-feeding the channels gives a wide ping-pong tail for free.
    this.bufL[this.idx] = this.dampL.process(l + dr * this.feedback);
    this.bufR[this.idx] = this.dampR.process(r + dl * this.feedback);
    this.idx = (this.idx + 1) % this.size;
    out[0] = dl;
    out[1] = dr;
  }
}

/* ----------------------------------------------------------------- reverb */

class Comb {
  private buf: Float32Array;
  private idx = 0;
  private damp = new OnePole();
  constructor(size: number, private readonly feedback: number, damping: number) {
    this.buf = new Float32Array(size);
    this.damp.setCoefficient(damping);
  }
  process(x: number): number {
    const y = this.buf[this.idx]!;
    this.buf[this.idx] = x + this.damp.process(y) * this.feedback;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

class Allpass {
  private buf: Float32Array;
  private idx = 0;
  constructor(size: number, private readonly gain: number) {
    this.buf = new Float32Array(size);
  }
  process(x: number): number {
    const bufOut = this.buf[this.idx]!;
    const out = -x + bufOut;
    this.buf[this.idx] = x + bufOut * this.gain;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }
}

/**
 * Schroeder/Freeverb-style reverb: four parallel damped combs feeding two
 * series allpasses, per channel, with the right channel's delays offset so the
 * tail is decorrelated and genuinely stereo.
 */
export class Reverb {
  private combsL: Comb[];
  private combsR: Comb[];
  private apL: Allpass[];
  private apR: Allpass[];

  constructor(sampleRate: number, roomSize = 0.82, damping = 0.35) {
    const scale = sampleRate / 44100;
    const combTimes = [1557, 1617, 1491, 1422, 1277, 1356];
    const apTimes = [225, 556, 441];
    const stereoSpread = Math.round(23 * scale);
    const fb = 0.72 + roomSize * 0.26;
    const s = (n: number) => Math.max(8, Math.round(n * scale));
    this.combsL = combTimes.map((t) => new Comb(s(t), fb, damping));
    this.combsR = combTimes.map((t) => new Comb(s(t) + stereoSpread, fb, damping));
    this.apL = apTimes.map((t) => new Allpass(s(t), 0.5));
    this.apR = apTimes.map((t) => new Allpass(s(t) + stereoSpread, 0.5));
  }

  process(l: number, r: number, out: [number, number]): void {
    let yl = 0;
    let yr = 0;
    for (let i = 0; i < this.combsL.length; i++) {
      yl += this.combsL[i]!.process(l);
      yr += this.combsR[i]!.process(r);
    }
    yl /= this.combsL.length;
    yr /= this.combsR.length;
    for (let i = 0; i < this.apL.length; i++) {
      yl = this.apL[i]!.process(yl);
      yr = this.apR[i]!.process(yr);
    }
    out[0] = yl;
    out[1] = yr;
  }
}

/* -------------------------------------------------------------- dynamics */

/** Soft saturation. Gentle below ~0.5, progressively rounded above it. */
export function saturate(x: number, drive = 1.4): number {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

/**
 * Look-ahead-free soft limiter: a peak follower with fast attack and slow
 * release drives the gain, then tanh catches anything that slips through.
 */
export class SoftLimiter {
  private env = 0;
  private readonly atk: number;
  private readonly rel: number;

  constructor(sampleRate: number, private readonly ceiling = 0.92, attackMs = 1.2, releaseMs = 140) {
    this.atk = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
    this.rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  }

  process(l: number, r: number, out: [number, number]): void {
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const coeff = peak > this.env ? this.atk : this.rel;
    this.env = peak + (this.env - peak) * coeff;
    const gain = this.env > this.ceiling ? this.ceiling / this.env : 1;
    out[0] = saturate(l * gain, 1.05);
    out[1] = saturate(r * gain, 1.05);
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Equal-power pan. `pan` in -1..1. */
export function panGains(pan: number): [number, number] {
  const p = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI;
  return [Math.cos(p), Math.sin(p)];
}
