/**
 * The conductor. Takes a seed and a style, runs theory -> harmony -> rhythm ->
 * structure -> synthesis, and hands back audio, a score and a session object.
 *
 * Pure computation: no fs, no Web Audio, no timers. Node and the browser both
 * call this exact function.
 */

import { Rng, streamFor } from './rng.js';
import { BarChord, chordAtBar, generateProgression } from './harmony.js';
import { camelot, camelotKey, Key, keyName, parseKey, shortKeyName } from './theory.js';
import { DrumHit, NoteEvent, generateBass, generateDrums, generateMelody, generatePad } from './rhythm.js';
import { Section, buildStructure, energyCurve, sectionAtBar } from './structure.js';
import { STYLES, StyleName } from './styles.js';
import { Session, SESSION_SCHEMA_VERSION, SessionChord, SessionSection } from './session.js';
import {
  Bus,
  StereoBuffer,
  TimedDrumHit,
  buildDuckEnvelope,
  createBuffer,
  dbfs,
  mixdown,
  patchFor,
  peakOf,
  renderDrum,
  renderVinyl,
  renderVoice,
  rmsOf,
} from './synth.js';

export const BEATS_PER_BAR = 4;
export const DEFAULT_SAMPLE_RATE = 44100;
export const GENERATOR_ID = 'groovebox@0.1.0';

export interface GenerateOptions {
  seed: number;
  style: StyleName;
  bars: number;
  bpm?: number;
  /** "Am", "F# minor", "C dorian"... */
  key?: string | Key;
  sampleRate?: number;
  /** 0..1 progress callback, used by the web player. */
  onProgress?: (fraction: number, label: string) => void;
}

export interface Score {
  pad: NoteEvent[];
  bass: NoteEvent[];
  lead: NoteEvent[];
  drums: DrumHit[];
}

export interface StemLevels {
  /** RMS in dBFS per stem, measured before the master chain. */
  [stem: string]: number;
}

export interface GenerateResult {
  seed: number;
  style: StyleName;
  bpm: number;
  key: Key;
  bars: number;
  durationSec: number;
  secondsPerBeat: number;
  progression: BarChord[];
  sections: Section[];
  score: Score;
  audio: StereoBuffer;
  session: Session;
  /** Pre-master stem levels, handy for sanity-checking the balance. */
  stemLevels: StemLevels;
}

/** Resolve bpm/key from the seed when the caller did not pin them. */
export function resolveMusicalParams(options: GenerateOptions): { bpm: number; key: Key } {
  const preset = STYLES[options.style];
  const rng = streamFor(options.seed, `params:${options.style}`);

  const bpm = options.bpm ?? Math.round(rng.range(preset.bpmRange[0], preset.bpmRange[1] + 0.999));

  let key: Key;
  if (options.key && typeof options.key === 'object') {
    key = options.key;
  } else if (typeof options.key === 'string' && options.key.trim() !== '') {
    key = parseKey(options.key);
  } else {
    key = { tonic: rng.pick(preset.tonics), scale: rng.pick(preset.scales) };
  }
  return { bpm, key };
}

/** Per-stem trims. Tuned by measuring stem RMS so nothing hides in the mix. */
const STEM_GAIN: Record<StyleName, { drums: number; bass: number; pad: number; lead: number; texture: number }> = {
  lofi: { drums: 0.8, bass: 1.0, pad: 1.05, lead: 1.0, texture: 0.9 },
  house: { drums: 0.82, bass: 0.95, pad: 1.0, lead: 1.0, texture: 0.6 },
  ambient: { drums: 1.1, bass: 1.0, pad: 1.1, lead: 1.05, texture: 0.9 },
  dnb: { drums: 0.92, bass: 1.05, pad: 0.88, lead: 0.92, texture: 0.6 },
};

export function generate(options: GenerateOptions): GenerateResult {
  const style = options.style;
  const preset = STYLES[style];
  const bars = Math.max(4, Math.round(options.bars));
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const progress = options.onProgress ?? (() => undefined);

  const { bpm, key } = resolveMusicalParams(options);
  const secondsPerBeat = 60 / bpm;
  const barSec = secondsPerBeat * BEATS_PER_BAR;

  progress(0.02, 'structure');
  const sections = buildStructure(style, bars, streamFor(options.seed, `form:${style}`));

  progress(0.08, 'harmony');
  const progression = generateProgression({
    key,
    style,
    bars,
    rng: streamFor(options.seed, `harmony:${style}`),
    centre: style === 'ambient' ? 57 : 60,
  });

  progress(0.14, 'rhythm');
  const drums = generateDrums({
    bars,
    sections,
    style,
    swing: preset.swing,
    rng: streamFor(options.seed, `drums:${style}`),
  });
  const bass = generateBass({
    bars,
    sections,
    progression,
    key,
    style,
    swing: preset.swing,
    rng: streamFor(options.seed, `bass:${style}`),
  });
  const lead = generateMelody({
    bars,
    sections,
    progression,
    key,
    style,
    swing: preset.swing,
    rng: streamFor(options.seed, `lead:${style}`),
  });
  const pad = generatePad({ bars, sections, progression, rng: streamFor(options.seed, `pad:${style}`) });

  // Tail long enough for the last reverb/release to decay naturally.
  const tailSec = style === 'ambient' ? 5.0 : 2.6;
  const musicSec = bars * barSec;
  const durationSec = musicSec + tailSec;
  const frames = Math.ceil(durationSec * sampleRate);

  progress(0.2, 'voices');
  const drumBus = createBuffer(frames, sampleRate);
  const bassBus = createBuffer(frames, sampleRate);
  const padBus = createBuffer(frames, sampleRate);
  const leadBus = createBuffer(frames, sampleRate);
  const textureBus = createBuffer(frames, sampleRate);

  const drumRng = streamFor(options.seed, `drumsynth:${style}`);
  const timedDrums: TimedDrumHit[] = drums.map((h) => ({ ...h, beatSec: h.beat * secondsPerBeat }));
  for (const hit of timedDrums) renderDrum(drumBus, hit, style, drumRng);

  progress(0.45, 'bass');
  const bassPatch = patchFor(style, 'bass');
  const bassRng = streamFor(options.seed, `bassvoice:${style}`);
  for (const n of bass) {
    renderVoice(bassBus, bassPatch, n.beat * secondsPerBeat, n.dur * secondsPerBeat, n.midi, n.vel, bassRng);
  }

  progress(0.58, 'pad');
  const padPatch = patchFor(style, 'pad');
  const padRng = streamFor(options.seed, `padvoice:${style}`);
  for (const n of pad) {
    renderVoice(padBus, padPatch, n.beat * secondsPerBeat, n.dur * secondsPerBeat, n.midi, n.vel, padRng);
  }

  progress(0.74, 'melody');
  const leadPatch = patchFor(style, 'lead');
  const leadRng = streamFor(options.seed, `leadvoice:${style}`);
  for (const n of lead) {
    renderVoice(leadBus, leadPatch, n.beat * secondsPerBeat, n.dur * secondsPerBeat, n.midi, n.vel, leadRng);
  }

  progress(0.82, 'texture');
  renderVinyl(textureBus, preset.noiseBed, streamFor(options.seed, `vinyl:${style}`), durationSec);
  // Gate the texture with the form so the intro/outro breathe with the track.
  applySectionGate(textureBus, sections, bars, barSec, 'texture');

  const stemLevels: StemLevels = {
    drums: dbfs(rmsOf(drumBus)),
    bass: dbfs(rmsOf(bassBus)),
    pad: dbfs(rmsOf(padBus)),
    lead: dbfs(rmsOf(leadBus)),
    texture: dbfs(rmsOf(textureBus)),
  };

  progress(0.88, 'mix');
  const kickTimes = timedDrums.filter((h) => h.type === 'kick').map((h) => h.beatSec);
  const duckEnv = buildDuckEnvelope(
    frames,
    sampleRate,
    kickTimes,
    preset.duck,
    Math.min(0.42, secondsPerBeat * (style === 'dnb' ? 0.45 : 0.72)),
  );

  const trims = STEM_GAIN[style];
  const buses: Bus[] = [
    { buffer: drumBus, reverbSend: style === 'ambient' ? 0.24 : 0.09, delaySend: 0.02, duck: 0, gain: trims.drums },
    { buffer: bassBus, reverbSend: 0.02, delaySend: 0, duck: bassPatch.duck, gain: trims.bass },
    { buffer: padBus, reverbSend: padPatch.reverb, delaySend: padPatch.delay, duck: padPatch.duck, gain: trims.pad },
    { buffer: leadBus, reverbSend: leadPatch.reverb, delaySend: leadPatch.delay, duck: leadPatch.duck, gain: trims.lead },
    { buffer: textureBus, reverbSend: 0.12, delaySend: 0, duck: preset.duck * 0.4, gain: trims.texture },
  ];

  // A dotted-8th delay is the classic "musical" delay time.
  const delayTime = secondsPerBeat * (style === 'ambient' ? 1.5 : 0.75);
  const audio = mixdown(buses, duckEnv, {
    sampleRate,
    reverbRoom: style === 'ambient' ? 0.94 : style === 'lofi' ? 0.8 : 0.72,
    reverbDamping: style === 'lofi' ? 0.52 : 0.35,
    delayTimeSec: delayTime,
    delayFeedback: style === 'ambient' ? 0.52 : 0.34,
    fadeOutSec: Math.min(barSec * 2, tailSec + barSec),
    targetPeakDb: -1.0,
  });

  progress(0.97, 'session');
  const session = buildSession({
    seed: options.seed,
    style,
    bpm,
    key,
    bars,
    sections,
    progression,
    secondsPerBeat,
    durationSec,
    audio,
  });

  progress(1, 'done');

  return {
    seed: options.seed,
    style,
    bpm,
    key,
    bars,
    durationSec,
    secondsPerBeat,
    progression,
    sections,
    score: { pad, bass, lead, drums },
    audio,
    session,
    stemLevels,
  };
}

/** Silence a bus outside the sections that declare the given layer. */
function applySectionGate(bus: StereoBuffer, sections: Section[], bars: number, barSec: number, layer: 'texture'): void {
  const sr = bus.sampleRate;
  const ramp = Math.floor(0.08 * sr);
  for (let bar = 0; bar < bars; bar++) {
    const section = sectionAtBar(sections, bar);
    if (section.layers.has(layer)) continue;
    const from = Math.floor(bar * barSec * sr);
    const to = Math.min(bus.left.length, Math.floor((bar + 1) * barSec * sr));
    for (let i = from; i < to; i++) {
      const edge = Math.min(i - from, to - i, ramp);
      const g = ramp > 0 ? 1 - edge / ramp : 0;
      bus.left[i] *= g;
      bus.right[i] *= g;
    }
  }
}

interface SessionInput {
  seed: number;
  style: StyleName;
  bpm: number;
  key: Key;
  bars: number;
  sections: Section[];
  progression: BarChord[];
  secondsPerBeat: number;
  durationSec: number;
  audio: StereoBuffer;
}

export function buildSession(input: SessionInput): Session {
  const barSec = input.secondsPerBeat * BEATS_PER_BAR;

  const sections: SessionSection[] = input.sections.map((s) => ({
    name: s.name,
    startBar: s.startBar,
    bars: s.bars,
    startSec: round3(s.startBar * barSec),
    durationSec: round3(s.bars * barSec),
    energy: round3(s.energy),
    layers: [...s.layers].sort(),
  }));

  const chords: SessionChord[] = input.progression
    .filter((bc) => bc.bar < input.bars)
    .map((bc) => ({
      bar: bc.bar,
      bars: Math.min(bc.bars, input.bars - bc.bar),
      startSec: round3(bc.bar * barSec),
      degree: bc.chord.label,
      name: bc.chord.name,
      notes: bc.chord.pitchClasses.slice().sort((a, b) => a - b),
      voicing: bc.voicing.slice(),
    }));

  const downbeats: number[] = [];
  for (let bar = 0; bar < input.bars; bar++) downbeats.push(round3(bar * barSec));

  return {
    schema: SESSION_SCHEMA_VERSION,
    generator: GENERATOR_ID,
    seed: input.seed,
    style: input.style,
    bpm: input.bpm,
    key: shortKeyName(input.key),
    keyName: keyName(input.key),
    camelot: camelot(input.key),
    camelotKey: camelotKey(input.key),
    scale: input.key.scale,
    bars: input.bars,
    beatsPerBar: BEATS_PER_BAR,
    durationSec: round3(input.durationSec),
    sections,
    chords,
    energyCurve: energyCurve(input.sections, input.bars).map(round3),
    downbeats,
    stats: {
      peakDb: round3(dbfs(peakOf(input.audio))),
      rmsDb: round3(dbfs(rmsOf(input.audio))),
      sampleRate: input.audio.sampleRate,
      frames: input.audio.left.length,
    },
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export { chordAtBar, sectionAtBar };
export type { Rng };
