/**
 * Rhythm section: drums, bass and melody.
 *
 * Drums are 16th-step patterns per style, then run through swing, velocity
 * humanisation, ghost notes and an every-8-bars fill. Bass locks to the chord
 * roots. The melody is built from 2-3 seeded motifs that recur with variation,
 * which is the difference between "music" and "notes that fit the scale".
 */

import { Rng } from './rng.js';
import { BarChord, chordAtBar } from './harmony.js';
import { Key, mod, pitchClassAbove, scaleLadder } from './theory.js';
import { Section, sectionAtBar } from './structure.js';
import type { StyleName } from './styles.js';

export type DrumType = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'ride' | 'rim';

export interface DrumHit {
  /** Position in quarter-note beats from the start of the song. */
  beat: number;
  type: DrumType;
  /** 0..1 */
  vel: number;
}

export interface NoteEvent {
  beat: number;
  /** Length in beats. */
  dur: number;
  midi: number;
  vel: number;
}

const STEPS_PER_BAR = 16;
const BEATS_PER_BAR = 4;

/** `1` where a hit lands. `2` marks an accent, `0.5` a ghost note. */
interface DrumPattern {
  kick: number[];
  snare: number[];
  clap: number[];
  hat: number[];
  ohat: number[];
  ride: number[];
  rim: number[];
}

function empty(): number[] {
  return new Array(STEPS_PER_BAR).fill(0);
}

function pat(...steps: Array<[number, number]>): number[] {
  const a = empty();
  for (const [i, v] of steps) a[i] = v;
  return a;
}

function everyN(n: number, v: number, offset = 0): number[] {
  const a = empty();
  for (let i = offset; i < STEPS_PER_BAR; i += n) a[i] = v;
  return a;
}

const PATTERNS: Record<StyleName, DrumPattern[]> = {
  // Boom-bap: kick on 1 and just behind 3, snare on 2 and 4, swung 8th hats.
  lofi: [
    {
      kick: pat([0, 1.0], [6, 0.7], [10, 0.85]),
      snare: pat([4, 1.0], [12, 1.0]),
      clap: empty(),
      hat: everyN(2, 0.62),
      ohat: pat([14, 0.5]),
      ride: empty(),
      rim: pat([7, 0.25], [15, 0.2]),
    },
    {
      kick: pat([0, 1.0], [8, 0.8], [11, 0.6]),
      snare: pat([4, 1.0], [12, 1.0], [14, 0.28]),
      clap: empty(),
      hat: everyN(2, 0.6),
      ohat: pat([6, 0.45]),
      ride: empty(),
      rim: pat([3, 0.22]),
    },
  ],
  // Four to the floor, offbeat open hats, clap doubling the backbeat.
  house: [
    {
      kick: everyN(4, 1.0),
      snare: empty(),
      clap: pat([4, 0.9], [12, 0.9]),
      hat: everyN(2, 0.42, 1),
      ohat: everyN(4, 0.6, 2),
      ride: empty(),
      rim: pat([7, 0.3], [15, 0.3]),
    },
    {
      kick: everyN(4, 1.0),
      snare: empty(),
      clap: pat([4, 0.9], [12, 0.9], [15, 0.3]),
      hat: everyN(1, 0.26),
      ohat: everyN(4, 0.58, 2),
      ride: empty(),
      rim: pat([10, 0.28]),
    },
  ],
  // Barely there: a soft pulse and a ride shimmer.
  ambient: [
    {
      kick: pat([0, 0.7]),
      snare: empty(),
      clap: empty(),
      hat: pat([6, 0.22], [14, 0.18]),
      ohat: empty(),
      ride: pat([0, 0.3], [8, 0.22]),
      rim: empty(),
    },
    {
      kick: pat([0, 0.65], [10, 0.4]),
      snare: empty(),
      clap: empty(),
      hat: pat([2, 0.16], [11, 0.2]),
      ohat: empty(),
      ride: pat([4, 0.26]),
      rim: empty(),
    },
  ],
  // Two-step: snare on 2 and 4, kick on 1 and the "a" of 3.
  dnb: [
    {
      kick: pat([0, 1.0], [10, 0.9]),
      snare: pat([4, 1.0], [12, 1.0]),
      clap: empty(),
      hat: everyN(2, 0.4),
      ohat: pat([6, 0.35], [14, 0.3]),
      ride: empty(),
      rim: pat([7, 0.25], [11, 0.2]),
    },
    {
      kick: pat([0, 1.0], [6, 0.55], [11, 0.85]),
      snare: pat([4, 1.0], [12, 1.0], [15, 0.35]),
      clap: empty(),
      hat: everyN(2, 0.38),
      ohat: pat([2, 0.3]),
      ride: empty(),
      rim: pat([9, 0.22]),
    },
  ],
};

/** Convert a 16th step index to beats, applying swing to the off positions. */
export function stepToBeat(step: number, swing: number): number {
  const beat = step / 4;
  if (swing <= 0.5) return beat;
  const inEighth = step % 4;
  if (inEighth === 2) return beat + (swing - 0.5); // swung off-8th
  if (inEighth === 1 || inEighth === 3) return beat + (swing - 0.5) * 0.5; // 16ths ride along
  return beat;
}

export interface DrumOptions {
  bars: number;
  sections: Section[];
  style: StyleName;
  swing: number;
  rng: Rng;
}

export function generateDrums(opts: DrumOptions): DrumHit[] {
  const variants = PATTERNS[opts.style];
  const hits: DrumHit[] = [];
  const rng = opts.rng;

  for (let bar = 0; bar < opts.bars; bar++) {
    const section = sectionAtBar(opts.sections, bar);
    const hasDrums = section.layers.has('drums');
    const hasHats = section.layers.has('hats');
    if (!hasDrums && !hasHats) continue;

    // Alternate the two variants, with the B variant favoured on odd bars.
    const variant = variants[(bar % 4 === 3 ? 1 : bar % 2) % variants.length]!;
    const barBeat = bar * BEATS_PER_BAR;
    const energy = section.energy;
    const isFill = hasDrums && bar % 8 === 7 && bar !== opts.bars - 1;

    const emit = (type: DrumType, step: number, base: number, allowed: boolean) => {
      if (!allowed || base <= 0) return;
      const jitter = (rng.next() - 0.5) * 0.012; // a few ms of human drift
      const vel = clamp(base * (0.78 + energy * 0.34) * (0.9 + rng.next() * 0.2), 0.02, 1);
      hits.push({ beat: barBeat + stepToBeat(step, opts.swing) + jitter, type, vel });
    };

    for (let step = 0; step < STEPS_PER_BAR; step++) {
      emit('kick', step, variant.kick[step]!, hasDrums);
      emit('snare', step, variant.snare[step]!, hasDrums);
      emit('clap', step, variant.clap[step]!, hasDrums);
      emit('rim', step, variant.rim[step]!, hasDrums && energy > 0.5);
      emit('hat', step, variant.hat[step]!, hasHats);
      emit('ohat', step, variant.ohat[step]!, hasHats);
      emit('ride', step, variant.ride[step]!, hasHats);
    }

    // Ghost notes: quiet snare taps in the gaps, only when the kit is busy.
    if (hasDrums && energy > 0.45) {
      for (const step of [2, 6, 10, 14]) {
        if (variant.snare[step]! === 0 && rng.chance(0.16 + energy * 0.12)) {
          emit('snare', step, 0.18 + rng.next() * 0.1, true);
        }
      }
    }

    // Fill on the last bar of each 8-bar phrase.
    if (isFill) {
      const density = rng.pick([2, 2, 1]);
      const from = rng.pick([8, 10, 12]);
      for (let step = from; step < STEPS_PER_BAR; step += density) {
        const t = (step - from) / Math.max(1, STEPS_PER_BAR - from);
        emit('snare', step, 0.45 + t * 0.5, true);
      }
      if (rng.chance(0.6)) emit('ohat', 15, 0.5, hasHats);
    }
  }

  hits.sort((a, b) => a.beat - b.beat);
  return hits;
}

/* ------------------------------------------------------------------- bass */

export interface BassOptions {
  bars: number;
  sections: Section[];
  progression: BarChord[];
  key: Key;
  style: StyleName;
  swing: number;
  rng: Rng;
}

export function generateBass(opts: BassOptions): NoteEvent[] {
  const out: NoteEvent[] = [];
  const rng = opts.rng;
  const ladder = scaleLadder(opts.key, 28, 55);

  for (let bar = 0; bar < opts.bars; bar++) {
    const section = sectionAtBar(opts.sections, bar);
    if (!section.layers.has('bass')) continue;

    const bc = chordAtBar(opts.progression, bar);
    const nextBc = chordAtBar(opts.progression, bar + 1);
    const root = pitchClassAbove(bc.chord.root, 33); // roughly A1..A2
    const barBeat = bar * BEATS_PER_BAR;
    const isLastBarOfChord = bar + 1 >= bc.bar + bc.bars;
    const energy = section.energy;

    const push = (beat: number, dur: number, midi: number, vel: number) => {
      out.push({ beat: barBeat + beat, dur, midi, vel: clamp(vel, 0.05, 1) });
    };

    switch (opts.style) {
      case 'lofi': {
        push(0, rng.chance(0.4) ? 1.5 : 1.0, root, 0.85);
        if (rng.chance(0.65)) {
          const alt = rng.chance(0.35) ? root + 12 : root + fifthOffset(bc.chord.intervals);
          push(stepToBeat(6, opts.swing), 0.6, alt, 0.6);
        }
        push(stepToBeat(10, opts.swing), 0.9, root, 0.72);
        break;
      }
      case 'house': {
        for (const step of [2, 6, 10, 14]) {
          if (!rng.chance(0.85)) continue;
          const oct = rng.chance(0.18) ? 12 : 0;
          push(stepToBeat(step, opts.swing), 0.42, root + oct, 0.66 + rng.next() * 0.16);
        }
        push(0, 0.45, root, 0.9);
        break;
      }
      case 'ambient': {
        push(0, BEATS_PER_BAR * 0.98, root - 12, 0.5 + energy * 0.2);
        break;
      }
      case 'dnb': {
        push(0, 1.6, root - 12, 0.95);
        if (energy > 0.6) {
          push(stepToBeat(10, opts.swing), 0.5, root - 12, 0.72);
          if (rng.chance(0.5)) push(stepToBeat(14, opts.swing), 0.4, root - 12 + fifthOffset(bc.chord.intervals), 0.6);
        }
        break;
      }
    }

    // Passing note into the next chord on the last bar a chord is held.
    if (isLastBarOfChord && nextBc.chord.root !== bc.chord.root && rng.chance(0.55) && opts.style !== 'ambient') {
      const target = pitchClassAbove(nextBc.chord.root, 33);
      const approach = nearestLadder(ladder, target + (target > root ? -1 : 1));
      push(3.5, 0.45, approach, 0.55);
    }
  }

  out.sort((a, b) => a.beat - b.beat);
  return out;
}

function fifthOffset(intervals: number[]): number {
  return intervals.includes(7) ? 7 : intervals.includes(6) ? 6 : intervals.includes(8) ? 8 : 7;
}

function nearestLadder(ladder: number[], midi: number): number {
  let best = midi;
  let bestD = Infinity;
  for (const n of ladder) {
    const d = Math.abs(n - midi);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/* ----------------------------------------------------------------- melody */

interface MotifNote {
  /** Offset within the motif, in beats. */
  offset: number;
  dur: number;
  /** Contour movement in scale steps from the previous note. */
  step: number;
}

export interface Motif {
  notes: MotifNote[];
  length: number;
}

const RHYTHM_CELLS: Record<StyleName, number[][]> = {
  lofi: [
    [0.5, 0.5, 1],
    [0.75, 0.25, 1],
    [1, 0.5, 0.5],
    [0.5, 0.25, 0.25, 1],
    [1.5, 0.5],
  ],
  house: [
    [0.5, 0.5, 0.5, 0.5],
    [1, 0.5, 0.5],
    [0.25, 0.25, 0.5, 1],
    [0.5, 1, 0.5],
  ],
  ambient: [
    [2, 2],
    [1.5, 2.5],
    [3, 1],
    [2, 1, 1],
  ],
  dnb: [
    [0.5, 0.5, 1],
    [0.25, 0.25, 0.5, 1],
    [1, 1],
    [0.75, 0.75, 0.5],
  ],
};

/** Build 2-3 motifs: a rhythm cell plus a contour of scale steps. */
export function generateMotifs(style: StyleName, rng: Rng): Motif[] {
  const count = style === 'ambient' ? 2 : rng.int(2, 3);
  const motifs: Motif[] = [];
  for (let m = 0; m < count; m++) {
    const cell = rng.pick(RHYTHM_CELLS[style]);
    const notes: MotifNote[] = [];
    let cursor = 0;
    for (let i = 0; i < cell.length; i++) {
      const dur = cell[i]!;
      // Small steps dominate; the occasional leap gives the line a shape.
      const step = i === 0 ? 0 : rng.weighted([-3, -2, -1, 0, 1, 2, 3, 4], [1, 2.5, 4, 1.2, 4, 2.5, 1, 0.5]);
      notes.push({ offset: cursor, dur: dur * 0.92, step });
      cursor += dur;
    }
    motifs.push({ notes, length: cursor });
  }
  return motifs;
}

/** Apply a deterministic variation to a motif. */
function varyMotif(motif: Motif, rng: Rng): Motif {
  const kind = rng.weighted(['none', 'transpose', 'invert', 'thin', 'tail'], [3, 2.5, 1.2, 1.5, 1.5]);
  const notes = motif.notes.map((n) => ({ ...n }));
  switch (kind) {
    case 'transpose': {
      const shift = rng.pick([-2, -1, 1, 2]);
      if (notes.length > 0) notes[0]!.step += shift;
      break;
    }
    case 'invert':
      for (let i = 1; i < notes.length; i++) notes[i]!.step = -notes[i]!.step;
      break;
    case 'thin':
      if (notes.length > 2) notes.splice(rng.int(1, notes.length - 1), 1);
      break;
    case 'tail':
      if (notes.length > 1) {
        const last = notes[notes.length - 1]!;
        last.step += rng.pick([-7, 7, 5]);
        last.dur *= 1.4;
      }
      break;
    default:
      break;
  }
  return { notes, length: motif.length };
}

export interface MelodyOptions {
  bars: number;
  sections: Section[];
  progression: BarChord[];
  key: Key;
  style: StyleName;
  swing: number;
  rng: Rng;
}

/**
 * Melody generation. Strong beats (1 and 3) are forced onto chord tones; other
 * positions may use any scale tone. Motifs repeat across the form with
 * variation so the ear recognises a theme.
 */
export function generateMelody(opts: MelodyOptions): NoteEvent[] {
  const rng = opts.rng;
  const motifs = generateMotifs(opts.style, rng);
  const lowNote = opts.style === 'dnb' ? 62 : 60;
  const ladder = scaleLadder(opts.key, lowNote, lowNote + 26);
  const out: NoteEvent[] = [];

  // Sparse by design -- lofi leads breathe, house leads are more insistent.
  const baseDensity: Record<StyleName, number> = { lofi: 0.82, house: 0.88, ambient: 0.78, dnb: 0.8 };

  let anchorIdx = Math.floor(ladder.length / 2);
  let lastMotif = 0;

  for (let bar = 0; bar < opts.bars; bar++) {
    const section = sectionAtBar(opts.sections, bar);
    if (!section.layers.has('lead')) continue;

    const density = baseDensity[opts.style] * (0.55 + section.energy * 0.6);
    if (!rng.chance(clamp(density, 0.3, 0.97))) continue;

    const bc = chordAtBar(opts.progression, bar);
    const chordPcs = bc.chord.pitchClasses;
    const barBeat = bar * BEATS_PER_BAR;

    // Reuse the previous motif most of the time; that is what makes a theme.
    const motifIndex = rng.chance(0.62) ? lastMotif : rng.int(0, motifs.length - 1);
    lastMotif = motifIndex;
    const motif = varyMotif(motifs[motifIndex]!, rng);

    let idx = anchorIdx;
    for (const note of motif.notes) {
      if (note.offset >= BEATS_PER_BAR) break;
      idx = clampInt(idx + note.step, 0, ladder.length - 1);
      let midi = ladder[idx]!;

      const isStrong = Math.abs(note.offset % 2) < 1e-6;
      if (isStrong && !chordPcs.includes(mod(midi, 12))) {
        // Nudge onto the nearest chord tone, keeping the contour direction.
        midi = nearestWithPitchClasses(midi, chordPcs);
        idx = nearestIndex(ladder, midi);
      }

      const swung = opts.swing > 0.5 && Math.abs((note.offset * 2) % 2 - 1) < 1e-6 ? (opts.swing - 0.5) : 0;
      const vel = clamp((isStrong ? 0.72 : 0.55) * (0.75 + section.energy * 0.45) + rng.range(-0.06, 0.06), 0.1, 1);
      out.push({ beat: barBeat + note.offset + swung, dur: Math.max(0.12, note.dur), midi, vel });
    }
    anchorIdx = clampInt(idx, 2, ladder.length - 3);
  }

  out.sort((a, b) => a.beat - b.beat);
  return out;
}

function nearestWithPitchClasses(midi: number, pcs: readonly number[]): number {
  for (let d = 0; d <= 6; d++) {
    for (const dir of d === 0 ? [0] : [-d, d]) {
      if (pcs.includes(mod(midi + dir, 12))) return midi + dir;
    }
  }
  return midi;
}

function nearestIndex(ladder: number[], midi: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i]! - midi);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/* -------------------------------------------------------------------- pad */

export interface PadOptions {
  bars: number;
  sections: Section[];
  progression: BarChord[];
  rng: Rng;
}

/** Pads simply hold the voiced chord for as long as the section wants it. */
export function generatePad(opts: PadOptions): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const bc of opts.progression) {
    if (bc.bar >= opts.bars) break;
    const section = sectionAtBar(opts.sections, bc.bar);
    if (!section.layers.has('pad')) continue;
    const barsHeld = Math.min(bc.bars, opts.bars - bc.bar);
    const beat = bc.bar * BEATS_PER_BAR;
    const dur = barsHeld * BEATS_PER_BAR * 0.97;
    for (const midi of bc.voicing) {
      out.push({ beat, dur, midi, vel: 0.5 + opts.rng.range(-0.04, 0.04) });
    }
  }
  return out;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function clampInt(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(x)));
}
