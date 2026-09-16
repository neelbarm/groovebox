/**
 * The software synthesiser: patches, drum synthesis, sidechain ducking, sends
 * and the master chain. Renders Float32 stereo at the requested sample rate.
 */

import {
  Adsr,
  Biquad,
  Reverb,
  SoftLimiter,
  StereoDelay,
  Waveform,
  adsrValue,
  clamp,
  oscillator,
  panGains,
  saturate,
} from './dsp.js';
import { Rng } from './rng.js';
import { midiToFreq } from './theory.js';
import type { DrumHit, NoteEvent } from './rhythm.js';
import { STYLES, StyleName } from './styles.js';

export interface StereoBuffer {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export function createBuffer(frames: number, sampleRate: number): StereoBuffer {
  return { left: new Float32Array(frames), right: new Float32Array(frames), sampleRate };
}

interface OscSpec {
  wave: Waveform;
  /** Detune in cents. */
  detune: number;
  gain: number;
  /** Octave offset. */
  octave: number;
  /** Stereo position, -1..1. */
  pan: number;
}

export interface Patch {
  oscs: OscSpec[];
  env: Adsr;
  /** Filter cutoff in Hz at velocity 0. */
  cutoff: number;
  /** How far the envelope opens the filter, in Hz. */
  cutoffEnv: number;
  /** Cutoff tracks pitch by this fraction. */
  keyTrack: number;
  q: number;
  /** Slow filter wobble. */
  lfoRate: number;
  /** Wobble depth as a fraction of the cutoff. */
  lfoDepth: number;
  /** Pitch vibrato. */
  vibratoRate: number;
  /** Vibrato depth in cents. */
  vibratoDepth: number;
  gain: number;
  /** Reverb send, 0..1. */
  reverb: number;
  /** Delay send, 0..1. */
  delay: number;
  /** Sidechain sensitivity, 0..1. */
  duck: number;
}

const FILTER_BLOCK = 32; // recompute biquad coefficients this often

/** Render one note of a patch into a stereo bus. */
export function renderVoice(
  bus: StereoBuffer,
  patch: Patch,
  startSec: number,
  holdSec: number,
  midi: number,
  velocity: number,
  rng: Rng,
): void {
  const sr = bus.sampleRate;
  const total = holdSec + patch.env.release;
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(bus.left.length, Math.ceil((startSec + total) * sr));
  if (end <= start) return;

  const baseFreq = midiToFreq(midi);
  const phases = patch.oscs.map(() => rng.next());
  const gains = patch.oscs.map((o) => panGains(o.pan));
  const filterL = new Biquad(sr);
  const filterR = new Biquad(sr);
  const lfoPhase0 = rng.next();
  const vibPhase0 = rng.next();
  const noiseRng = rng.fork('voice-noise');
  const rand = () => noiseRng.next();

  const velGain = 0.25 + velocity * 0.85;
  let cutoffL = -1;

  for (let i = start; i < end; i++) {
    const t = i / sr - startSec;
    const env = adsrValue(patch.env, t, holdSec);
    if (env <= 0) continue;

    if ((i - start) % FILTER_BLOCK === 0) {
      const lfo = Math.sin(2 * Math.PI * (lfoPhase0 + patch.lfoRate * t));
      const cutoff =
        (patch.cutoff + patch.cutoffEnv * env * velocity + baseFreq * patch.keyTrack) *
        (1 + patch.lfoDepth * lfo);
      const target = clamp(cutoff, 40, sr * 0.45);
      if (Math.abs(target - cutoffL) > 0.5) {
        filterL.setLowpass(target, patch.q);
        filterR.setLowpass(target, patch.q);
        cutoffL = target;
      }
    }

    const vib =
      patch.vibratoDepth > 0
        ? Math.pow(2, (patch.vibratoDepth * Math.sin(2 * Math.PI * (vibPhase0 + patch.vibratoRate * t))) / 1200)
        : 1;

    let sl = 0;
    let sr2 = 0;
    for (let o = 0; o < patch.oscs.length; o++) {
      const spec = patch.oscs[o]!;
      const freq = baseFreq * Math.pow(2, spec.octave + spec.detune / 1200) * vib;
      const dt = freq / sr;
      let p = phases[o]! + dt;
      p -= Math.floor(p);
      phases[o] = p;
      const s = oscillator(spec.wave, p, dt, rand) * spec.gain;
      const [gl, gr] = gains[o]!;
      sl += s * gl;
      sr2 += s * gr;
    }

    const amp = env * velGain * patch.gain;
    bus.left[i] += filterL.process(sl) * amp;
    bus.right[i] += filterR.process(sr2) * amp;
  }
}

/* ----------------------------------------------------------------- patches */

function adsr(a: number, d: number, s: number, r: number): Adsr {
  return { attack: a, decay: d, sustain: s, release: r };
}

export type Instrument = 'pad' | 'bass' | 'lead';

/** Per-style instrument voicing. The lofi pad is the one that got the most love. */
export function patchFor(style: StyleName, instrument: Instrument): Patch {
  const base: Patch = {
    oscs: [],
    env: adsr(0.01, 0.2, 0.7, 0.3),
    cutoff: 1200,
    cutoffEnv: 800,
    keyTrack: 0.6,
    q: 0.9,
    lfoRate: 0.15,
    lfoDepth: 0,
    vibratoRate: 5,
    vibratoDepth: 0,
    gain: 0.3,
    reverb: 0.2,
    delay: 0,
    duck: 0,
  };

  if (instrument === 'pad') {
    switch (style) {
      case 'lofi':
        // Rhodes-ish: a soft triangle core, two barely-detuned saws for movement,
        // a slow filter wobble for tape warble, long release for the tail.
        return {
          ...base,
          oscs: [
            { wave: 'triangle', detune: 0, gain: 0.62, octave: 0, pan: 0 },
            { wave: 'saw', detune: -7, gain: 0.2, octave: 0, pan: -0.55 },
            { wave: 'saw', detune: 8, gain: 0.2, octave: 0, pan: 0.55 },
            { wave: 'sine', detune: 0, gain: 0.3, octave: 1, pan: 0 },
          ],
          env: adsr(0.14, 1.1, 0.55, 1.35),
          cutoff: 520,
          cutoffEnv: 900,
          keyTrack: 0.85,
          q: 1.1,
          lfoRate: 0.11,
          lfoDepth: 0.26,
          vibratoRate: 0.7,
          vibratoDepth: 5,
          gain: 0.27,
          reverb: STYLES.lofi.padReverb,
          delay: 0.1,
          duck: 0.85,
        };
      case 'house':
        return {
          ...base,
          oscs: [
            { wave: 'saw', detune: -9, gain: 0.34, octave: 0, pan: -0.6 },
            { wave: 'saw', detune: 9, gain: 0.34, octave: 0, pan: 0.6 },
            { wave: 'triangle', detune: 0, gain: 0.3, octave: 0, pan: 0 },
          ],
          env: adsr(0.05, 0.6, 0.6, 0.6),
          cutoff: 700,
          cutoffEnv: 1600,
          keyTrack: 0.8,
          q: 1.5,
          lfoRate: 0.08,
          lfoDepth: 0.12,
          gain: 0.34,
          reverb: STYLES.house.padReverb,
          delay: 0.08,
          duck: 1.0,
        };
      case 'ambient':
        return {
          ...base,
          oscs: [
            { wave: 'triangle', detune: -6, gain: 0.4, octave: 0, pan: -0.7 },
            { wave: 'triangle', detune: 6, gain: 0.4, octave: 0, pan: 0.7 },
            { wave: 'saw', detune: 0, gain: 0.12, octave: -1, pan: 0 },
            { wave: 'sine', detune: 3, gain: 0.26, octave: 1, pan: 0.2 },
          ],
          env: adsr(1.6, 2.5, 0.72, 3.2),
          cutoff: 540,
          cutoffEnv: 1300,
          keyTrack: 0.7,
          q: 0.8,
          lfoRate: 0.05,
          lfoDepth: 0.3,
          vibratoRate: 0.3,
          vibratoDepth: 6,
          gain: 0.24,
          reverb: STYLES.ambient.padReverb,
          delay: 0.2,
          duck: 0.4,
        };
      case 'dnb':
        return {
          ...base,
          oscs: [
            { wave: 'saw', detune: -8, gain: 0.3, octave: 0, pan: -0.5 },
            { wave: 'saw', detune: 8, gain: 0.3, octave: 0, pan: 0.5 },
            { wave: 'triangle', detune: 0, gain: 0.28, octave: 1, pan: 0 },
          ],
          env: adsr(0.25, 1.0, 0.5, 1.0),
          cutoff: 600,
          cutoffEnv: 1400,
          keyTrack: 0.75,
          q: 1.2,
          lfoRate: 0.13,
          lfoDepth: 0.18,
          gain: 0.25,
          reverb: STYLES.dnb.padReverb,
          delay: 0.1,
          duck: 0.8,
        };
    }
  }

  if (instrument === 'bass') {
    switch (style) {
      case 'lofi':
        return {
          ...base,
          oscs: [
            { wave: 'sine', detune: 0, gain: 0.8, octave: 0, pan: 0 },
            { wave: 'triangle', detune: 4, gain: 0.3, octave: 0, pan: 0 },
            { wave: 'saw', detune: 0, gain: 0.1, octave: 1, pan: 0 },
          ],
          env: adsr(0.012, 0.35, 0.62, 0.22),
          cutoff: 180,
          cutoffEnv: 420,
          keyTrack: 1.1,
          q: 0.9,
          gain: 0.42,
          reverb: 0.02,
          duck: 0.55,
        };
      case 'house':
        return {
          ...base,
          oscs: [
            { wave: 'saw', detune: 0, gain: 0.55, octave: 0, pan: 0 },
            { wave: 'sine', detune: 0, gain: 0.6, octave: -0 as number, pan: 0 },
          ],
          env: adsr(0.006, 0.18, 0.35, 0.12),
          cutoff: 200,
          cutoffEnv: 700,
          keyTrack: 1.0,
          q: 1.4,
          gain: 0.48,
          reverb: 0.02,
          duck: 0.9,
        };
      case 'ambient':
        return {
          ...base,
          oscs: [
            { wave: 'sine', detune: 0, gain: 0.9, octave: 0, pan: 0 },
            { wave: 'triangle', detune: 5, gain: 0.2, octave: 1, pan: 0 },
          ],
          env: adsr(0.8, 1.5, 0.75, 1.8),
          cutoff: 150,
          cutoffEnv: 260,
          keyTrack: 1.0,
          q: 0.7,
          gain: 0.36,
          reverb: 0.2,
          duck: 0.25,
        };
      case 'dnb':
        return {
          ...base,
          oscs: [
            { wave: 'sine', detune: 0, gain: 0.85, octave: 0, pan: 0 },
            { wave: 'saw', detune: 6, gain: 0.3, octave: 1, pan: 0 },
            { wave: 'square', detune: -6, gain: 0.14, octave: 1, pan: 0 },
          ],
          env: adsr(0.008, 0.5, 0.7, 0.18),
          cutoff: 170,
          cutoffEnv: 900,
          keyTrack: 1.0,
          q: 1.6,
          lfoRate: 1.4,
          lfoDepth: 0.22,
          gain: 0.4,
          reverb: 0.02,
          duck: 0.7,
        };
    }
  }

  // lead
  switch (style) {
    case 'lofi':
      return {
        ...base,
        oscs: [
          { wave: 'triangle', detune: 0, gain: 0.6, octave: 0, pan: -0.15 },
          { wave: 'sine', detune: 6, gain: 0.35, octave: 0, pan: 0.2 },
          { wave: 'saw', detune: -4, gain: 0.08, octave: 0, pan: 0 },
        ],
        env: adsr(0.02, 0.5, 0.35, 0.55),
        cutoff: 900,
        cutoffEnv: 1500,
        keyTrack: 0.9,
        q: 1.0,
        lfoRate: 0.19,
        lfoDepth: 0.14,
        vibratoRate: 4.6,
        vibratoDepth: 9,
        gain: 0.42,
        reverb: 0.4,
        delay: STYLES.lofi.leadDelay,
        duck: 0.35,
      };
    case 'house':
      return {
        ...base,
        oscs: [
          { wave: 'square', detune: 0, gain: 0.32, octave: 0, pan: -0.25 },
          { wave: 'saw', detune: 7, gain: 0.3, octave: 0, pan: 0.25 },
        ],
        env: adsr(0.008, 0.25, 0.3, 0.3),
        cutoff: 1100,
        cutoffEnv: 2600,
        keyTrack: 1.0,
        q: 1.6,
        gain: 0.38,
        reverb: 0.3,
        delay: STYLES.house.leadDelay,
        duck: 0.5,
      };
    case 'ambient':
      return {
        ...base,
        oscs: [
          { wave: 'sine', detune: 0, gain: 0.7, octave: 0, pan: -0.3 },
          { wave: 'triangle', detune: 7, gain: 0.3, octave: 1, pan: 0.3 },
        ],
        env: adsr(0.6, 1.4, 0.5, 2.2),
        cutoff: 800,
        cutoffEnv: 900,
        keyTrack: 0.8,
        q: 0.8,
        vibratoRate: 0.4,
        vibratoDepth: 8,
        gain: 0.34,
        reverb: 0.75,
        delay: STYLES.ambient.leadDelay,
        duck: 0.2,
      };
    case 'dnb':
      return {
        ...base,
        oscs: [
          { wave: 'saw', detune: -6, gain: 0.26, octave: 0, pan: -0.35 },
          { wave: 'saw', detune: 6, gain: 0.26, octave: 0, pan: 0.35 },
          { wave: 'sine', detune: 0, gain: 0.3, octave: 1, pan: 0 },
        ],
        env: adsr(0.01, 0.35, 0.28, 0.4),
        cutoff: 1000,
        cutoffEnv: 2800,
        keyTrack: 1.0,
        q: 1.5,
        gain: 0.3,
        reverb: 0.35,
        delay: STYLES.dnb.leadDelay,
        duck: 0.45,
      };
  }
}

/* ------------------------------------------------------------------ drums */

/** A drum hit with its beat already converted to seconds. */
export interface TimedDrumHit extends DrumHit {
  beatSec: number;
}

/** Synthesise one drum hit directly into a bus. All of it is oscillators + noise. */
export function renderDrum(bus: StereoBuffer, hit: TimedDrumHit, style: StyleName, rng: Rng): void {
  const sr = bus.sampleRate;
  const start = Math.max(0, Math.floor(hit.beatSec * sr));
  const v = hit.vel;

  const write = (i: number, l: number, r: number) => {
    if (i < 0 || i >= bus.left.length) return;
    bus.left[i] += l;
    bus.right[i] += r;
  };

  switch (hit.type) {
    case 'kick': {
      // 808-style: a sine whose pitch drops fast from ~115Hz to ~45Hz, plus a
      // short click so it cuts through on small speakers.
      const dur = style === 'dnb' ? 0.42 : style === 'house' ? 0.5 : 0.6;
      const n = Math.floor(dur * sr);
      const f0 = style === 'dnb' ? 130 : 115;
      const f1 = style === 'house' ? 48 : 44;
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const pitchEnv = Math.exp(-t / 0.035);
        const freq = f1 + (f0 - f1) * pitchEnv;
        phase += freq / sr;
        const amp = Math.exp(-t / (dur * 0.26)) * v * 0.92;
        const click = t < 0.004 ? (1 - t / 0.004) * 0.3 * v : 0;
        const s = saturate(Math.sin(2 * Math.PI * phase) * amp * 1.4, 1.2) + click;
        write(start + i, s, s);
      }
      break;
    }
    case 'snare': {
      const dur = v < 0.35 ? 0.09 : 0.22;
      const n = Math.floor(dur * sr);
      const bp = new Biquad(sr);
      bp.setBandpass(style === 'lofi' ? 1500 : 1900, 0.8);
      const hp = new Biquad(sr);
      hp.setHighpass(320, 0.7);
      let p1 = 0;
      let p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const noiseAmp = Math.exp(-t / (dur * 0.3)) * v;
        const toneAmp = Math.exp(-t / 0.055) * v * 0.6;
        p1 += 185 / sr;
        p2 += 278 / sr;
        const noise = hp.process(bp.process(rng.next() * 2 - 1)) * noiseAmp * 1.6;
        const tone = (Math.sin(2 * Math.PI * p1) + Math.sin(2 * Math.PI * p2) * 0.6) * toneAmp * 0.35;
        const s = saturate((noise + tone) * 0.8, 1.1);
        write(start + i, s * 0.98, s * 1.02);
      }
      break;
    }
    case 'clap': {
      // Four short bursts a few ms apart is what makes a clap sound like hands.
      const bursts = [0, 0.009, 0.019, 0.032];
      const bp = new Biquad(sr);
      bp.setBandpass(1350, 0.9);
      const n = Math.floor(0.26 * sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let amp = 0;
        for (let b = 0; b < bursts.length; b++) {
          const dt = t - bursts[b]!;
          if (dt >= 0) amp += Math.exp(-dt / (b === bursts.length - 1 ? 0.12 : 0.006)) * (b === bursts.length - 1 ? 1 : 0.8);
        }
        const s = bp.process(rng.next() * 2 - 1) * amp * v * 0.5;
        write(start + i, s * 1.05, s * 0.95);
      }
      break;
    }
    case 'hat':
    case 'ohat':
    case 'ride': {
      const dur = hit.type === 'hat' ? 0.045 : hit.type === 'ohat' ? 0.26 : 0.7;
      const n = Math.floor(dur * sr);
      const hp = new Biquad(sr);
      hp.setHighpass(hit.type === 'ride' ? 4200 : 7200, 0.8);
      const bp = new Biquad(sr);
      bp.setBandpass(hit.type === 'ride' ? 5200 : 9500, 0.6);
      const pan = hit.type === 'ride' ? 0.35 : 0.18;
      const [gl, gr] = panGains(pan);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const amp = Math.exp(-t / (dur * 0.32)) * v * (hit.type === 'hat' ? 0.5 : 0.36);
        const s = hp.process(bp.process(rng.next() * 2 - 1)) * amp * 2.2;
        write(start + i, s * gl, s * gr);
      }
      break;
    }
    case 'rim': {
      const n = Math.floor(0.04 * sr);
      const bp = new Biquad(sr);
      bp.setBandpass(2100, 2.2);
      let p = 0;
      const [gl, gr] = panGains(-0.3);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const amp = Math.exp(-t / 0.008) * v * 0.55;
        p += 1720 / sr;
        const s = (bp.process(rng.next() * 2 - 1) * 1.4 + Math.sin(2 * Math.PI * p) * 0.5) * amp;
        write(start + i, s * gl, s * gr);
      }
      break;
    }
  }
}

/* ------------------------------------------------------- vinyl / texture */

/**
 * Vinyl bed: filtered noise for surface hiss plus randomly-spaced crackle pops
 * whose amplitude follows a Poisson-ish distribution. This one cheap layer is
 * most of what makes a lofi track read as "lofi".
 */
export function renderVinyl(bus: StereoBuffer, amount: number, rng: Rng, seconds: number): void {
  if (amount <= 0) return;
  const sr = bus.sampleRate;
  const n = Math.min(bus.left.length, Math.floor(seconds * sr));
  const hissL = new Biquad(sr);
  const hissR = new Biquad(sr);
  hissL.setBandpass(2600, 0.35);
  hissR.setBandpass(3100, 0.35);
  const hp = new Biquad(sr);
  hp.setHighpass(1400, 0.7);
  // Real vinyl noise is dusty, not bright: roll the whole bed off above ~7 kHz.
  const toneL = new Biquad(sr);
  const toneR = new Biquad(sr);
  toneL.setLowpass(7000, 0.7);
  toneR.setLowpass(7000, 0.7);

  const hissGain = 0.075 * amount;
  const crackleRate = 30 * amount; // pops per second
  let nextPop = rng.range(0, sr / Math.max(0.5, crackleRate));
  let popSamples = 0;
  let popAmp = 0;
  let popSign = 1;

  for (let i = 0; i < n; i++) {
    const white = rng.next() * 2 - 1;
    let l = hissL.process(white) * hissGain;
    let r = hissR.process(rng.next() * 2 - 1) * hissGain;

    if (i >= nextPop) {
      popSamples = Math.floor(rng.range(6, 40));
      popAmp = rng.range(0.12, 0.55) * amount;
      popSign = rng.chance(0.5) ? 1 : -1;
      nextPop = i + Math.max(64, rng.range(sr / Math.max(0.5, crackleRate) * 0.25, (sr / Math.max(0.5, crackleRate)) * 1.9));
    }
    if (popSamples > 0) {
      const k = popSamples;
      const pop = hp.process(popSign * popAmp * (rng.next() * 0.6 + 0.4)) * (k / 40);
      l += pop;
      r += pop * 0.85;
      popSamples--;
    }

    bus.left[i] += toneL.process(l);
    bus.right[i] += toneR.process(r);
  }
}

/* ---------------------------------------------------------- sidechain duck */

/**
 * Build a per-sample gain envelope that dips on every kick and recovers with a
 * smooth curve. Multiplying the pad/bass buses by this is the classic pump.
 */
export function buildDuckEnvelope(
  frames: number,
  sampleRate: number,
  kickTimes: number[],
  depth: number,
  releaseSec: number,
): Float32Array {
  const env = new Float32Array(frames).fill(1);
  if (depth <= 0 || kickTimes.length === 0) return env;
  const rel = Math.max(0.02, releaseSec);
  const relSamples = Math.floor(rel * sampleRate);
  const attackSamples = Math.max(1, Math.floor(0.004 * sampleRate));

  for (const time of kickTimes) {
    const k = Math.floor(time * sampleRate);
    for (let i = -attackSamples; i < relSamples; i++) {
      const idx = k + i;
      if (idx < 0 || idx >= frames) continue;
      let g: number;
      if (i < 0) {
        g = 1 - depth * (1 + i / attackSamples);
      } else {
        const x = i / relSamples;
        g = 1 - depth * Math.pow(1 - x, 2.2);
      }
      if (g < env[idx]!) env[idx] = g;
    }
  }
  return env;
}

/* ------------------------------------------------------------ master chain */

export interface MixOptions {
  sampleRate: number;
  reverbRoom: number;
  reverbDamping: number;
  delayTimeSec: number;
  delayFeedback: number;
  /** Seconds of fade at the very end. */
  fadeOutSec: number;
  /** Target peak in dBFS. */
  targetPeakDb: number;
}

export interface Bus {
  buffer: StereoBuffer;
  reverbSend: number;
  delaySend: number;
  /** Sidechain sensitivity 0..1. */
  duck: number;
  gain: number;
}

/**
 * Sum the buses through the sends, apply ducking, saturate, limit, normalise
 * and fade. Returns the finished stereo buffer.
 */
export function mixdown(buses: Bus[], duckEnv: Float32Array, opts: MixOptions): StereoBuffer {
  const frames = buses.length > 0 ? buses[0]!.buffer.left.length : 0;
  const sr = opts.sampleRate;
  const out = createBuffer(frames, sr);

  const reverb = new Reverb(sr, opts.reverbRoom, opts.reverbDamping);
  const delaySize = Math.max(64, Math.floor(opts.delayTimeSec * sr));
  const delay = new StereoDelay(delaySize, opts.delayFeedback, 0.4);
  const limiter = new SoftLimiter(sr, 0.9);
  // Subsonic energy is wasted headroom (and a DC offset from the kick's click),
  // so the master starts with a gentle 26 Hz high-pass on both channels.
  const dcL = new Biquad(sr);
  const dcR = new Biquad(sr);
  dcL.setHighpass(26, 0.6);
  dcR.setHighpass(26, 0.6);

  const rvOut: [number, number] = [0, 0];
  const dlOut: [number, number] = [0, 0];
  const limOut: [number, number] = [0, 0];

  for (let i = 0; i < frames; i++) {
    let dryL = 0;
    let dryR = 0;
    let rvL = 0;
    let rvR = 0;
    let dlL = 0;
    let dlR = 0;
    const duck = duckEnv[i]!;

    for (const bus of buses) {
      const g = bus.gain * (1 - bus.duck + bus.duck * duck);
      const l = bus.buffer.left[i]! * g;
      const r = bus.buffer.right[i]! * g;
      dryL += l;
      dryR += r;
      if (bus.reverbSend > 0) {
        rvL += l * bus.reverbSend;
        rvR += r * bus.reverbSend;
      }
      if (bus.delaySend > 0) {
        dlL += l * bus.delaySend;
        dlR += r * bus.delaySend;
      }
    }

    delay.process(dlL, dlR, dlOut);
    // Delay repeats feed the reverb too, which glues the two together.
    reverb.process(rvL + dlOut[0] * 0.35, rvR + dlOut[1] * 0.35, rvOut);

    let l = dryL + rvOut[0] * 0.9 + dlOut[0] * 0.55;
    let r = dryR + rvOut[1] * 0.9 + dlOut[1] * 0.55;

    l = saturate(dcL.process(l), 1.25);
    r = saturate(dcR.process(r), 1.25);
    limiter.process(l, r, limOut);
    out.left[i] = limOut[0];
    out.right[i] = limOut[1];
  }

  applyFades(out, opts.fadeOutSec);
  normalise(out, opts.targetPeakDb);
  return out;
}

/** Short fade-in to kill the DC click, long musical fade-out at the end. */
export function applyFades(buf: StereoBuffer, fadeOutSec: number): void {
  const sr = buf.sampleRate;
  const n = buf.left.length;
  const fin = Math.min(n, Math.floor(0.012 * sr));
  for (let i = 0; i < fin; i++) {
    const g = i / fin;
    buf.left[i] *= g;
    buf.right[i] *= g;
  }
  const fout = Math.min(n, Math.floor(Math.max(0.05, fadeOutSec) * sr));
  for (let i = 0; i < fout; i++) {
    const idx = n - fout + i;
    if (idx < 0) continue;
    const x = 1 - i / fout;
    const g = x * x * (3 - 2 * x); // smoothstep: no audible "shelf" at the end
    buf.left[idx] *= g;
    buf.right[idx] *= g;
  }
}

export function peakOf(buf: StereoBuffer): number {
  let peak = 0;
  for (let i = 0; i < buf.left.length; i++) {
    const a = Math.abs(buf.left[i]!);
    const b = Math.abs(buf.right[i]!);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return peak;
}

export function rmsOf(buf: StereoBuffer): number {
  let sum = 0;
  const n = buf.left.length;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) {
    sum += buf.left[i]! * buf.left[i]! + buf.right[i]! * buf.right[i]!;
  }
  return Math.sqrt(sum / (n * 2));
}

/** Scale so the loudest sample sits exactly at `targetDb` dBFS. */
export function normalise(buf: StereoBuffer, targetDb: number): number {
  const peak = peakOf(buf);
  if (peak <= 1e-9) return 0;
  const target = Math.pow(10, targetDb / 20);
  const gain = target / peak;
  for (let i = 0; i < buf.left.length; i++) {
    buf.left[i] *= gain;
    buf.right[i] *= gain;
  }
  return gain;
}

export function dbfs(amplitude: number): number {
  return amplitude <= 1e-9 ? -Infinity : 20 * Math.log10(amplitude);
}

export function noteEventsToSeconds(events: NoteEvent[], secondsPerBeat: number): Array<NoteEvent & { sec: number; durSec: number }> {
  return events.map((e) => ({ ...e, sec: e.beat * secondsPerBeat, durSec: e.dur * secondsPerBeat }));
}

export { clamp };
