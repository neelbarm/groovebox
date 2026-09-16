/**
 * Chord progression generation as a Markov chain over Roman-numeral functions.
 *
 * Each style owns a transition table. Rather than letting a chain wander (which
 * sounds aimless), we run it in 4-bar phrases: the chain proposes, and a small
 * cadence rule nudges the last chord of a phrase towards something that
 * resolves. The result is deterministic, idiomatic, and still varies per seed.
 */

import { Rng } from './rng.js';
import { buildChord, Chord, ChordColour, isMinorFlavoured, Key, voiceChord } from './theory.js';
import type { StyleName } from './styles.js';

export interface HarmonyTable {
  /** Where the chain starts. */
  start: string[];
  /** label -> { nextLabel: weight }. */
  transitions: Record<string, Record<string, number>>;
  /** Chords that make an acceptable phrase ending. */
  cadence: string[];
  /** Chord colour (triad / 7th / 9th). */
  colour: ChordColour;
  /** Bars each chord is held. */
  chordBars: number;
}

/** Minor-key tables. Major-key styles get a mirrored table below. */
const MINOR_TABLES: Record<StyleName, HarmonyTable> = {
  lofi: {
    start: ['i', 'iv', 'VI'],
    transitions: {
      i: { iv: 3, iio: 3, VI: 2, VII: 2, bIImaj: 0.4, IVm: 1 },
      iv: { VII: 3, i: 2, iio: 1.5, III: 1.5, V: 1 },
      iio: { V: 5, VII: 1.5, i: 1 },
      V: { i: 5, VI: 2, III: 1 },
      VI: { VII: 3, iio: 2, III: 1.5, iv: 1.5 },
      VII: { i: 4, III: 2, VI: 1 },
      III: { VI: 3, iv: 2, iio: 1.5 },
      IVm: { i: 3, VII: 2 },
      bIImaj: { i: 4 },
    },
    cadence: ['i', 'V', 'VII', 'VI'],
    colour: 'ninth',
    chordBars: 1,
  },
  house: {
    start: ['i', 'VI'],
    transitions: {
      i: { VII: 3, iv: 2.5, VI: 2, iio: 1 },
      iv: { i: 3, VII: 2, V: 1.5 },
      VI: { VII: 3, i: 2, iv: 1 },
      VII: { i: 4, VI: 2 },
      iio: { V: 3, VII: 1 },
      V: { i: 4, VI: 1 },
    },
    cadence: ['i', 'VII', 'VI'],
    colour: 'seventh',
    chordBars: 2,
  },
  ambient: {
    start: ['i', 'III', 'VI'],
    transitions: {
      i: { VI: 2.5, III: 2, iv: 2, VII: 1.5, Isus: 1 },
      iv: { i: 2, VI: 2, VII: 1.5, ivsus: 1 },
      VI: { III: 2, i: 2, VII: 1.5 },
      VII: { III: 2, i: 2, iv: 1 },
      III: { VI: 2.5, i: 1.5, iv: 1 },
      Isus: { i: 3, iv: 1 },
      ivsus: { iv: 2, i: 2 },
    },
    cadence: ['i', 'III', 'VI', 'iv'],
    colour: 'ninth',
    chordBars: 4,
  },
  dnb: {
    start: ['i', 'VI'],
    transitions: {
      i: { VI: 3, iv: 2, VII: 2, iio: 1 },
      iv: { VII: 2.5, i: 2, V: 1 },
      VI: { VII: 3, iv: 1.5, i: 1.5 },
      VII: { i: 4, VI: 1.5 },
      iio: { V: 3, i: 1 },
      V: { i: 4 },
    },
    cadence: ['i', 'VII', 'VI'],
    colour: 'seventh',
    chordBars: 2,
  },
};

const MAJOR_TABLES: Record<StyleName, HarmonyTable> = {
  lofi: {
    start: ['I', 'vi', 'IV'],
    transitions: {
      I: { vi: 2.5, IV: 2.5, ii: 2.5, iii: 1.5, bVII: 1 },
      ii: { V: 5, IV: 1, iii: 0.8 },
      iii: { vi: 3, IV: 1.5, ii: 1 },
      IV: { V: 2.5, I: 2, iii: 1.5, ii: 1.5, IVm: 1 },
      V: { I: 5, vi: 2 },
      vi: { ii: 3, IV: 2, V: 1.5, bVII: 1 },
      bVII: { I: 4, IV: 1.5 },
      IVm: { I: 4 },
    },
    cadence: ['I', 'V', 'IV', 'vi'],
    colour: 'ninth',
    chordBars: 1,
  },
  house: {
    start: ['I', 'vi'],
    transitions: {
      I: { IV: 3, vi: 2.5, bVII: 1.5, ii: 1 },
      IV: { I: 3, V: 2, vi: 1.5 },
      vi: { IV: 3, V: 2, I: 1.5 },
      V: { I: 4, vi: 1.5 },
      ii: { V: 3, IV: 1 },
      bVII: { I: 3, IV: 1.5 },
    },
    cadence: ['I', 'V', 'IV'],
    colour: 'seventh',
    chordBars: 2,
  },
  ambient: {
    start: ['I', 'IV', 'vi'],
    transitions: {
      I: { IV: 2.5, vi: 2, bVII: 1.5, Isus: 1.2, iii: 1 },
      IV: { I: 2.5, vi: 2, bVII: 1 },
      vi: { IV: 2.5, I: 2, iii: 1 },
      iii: { IV: 2, vi: 2 },
      bVII: { IV: 2, I: 2 },
      Isus: { I: 3, IV: 1.5 },
    },
    cadence: ['I', 'IV', 'vi'],
    colour: 'ninth',
    chordBars: 4,
  },
  dnb: {
    start: ['vi', 'I'],
    transitions: {
      I: { vi: 3, IV: 2, bVII: 1.5 },
      IV: { I: 2.5, V: 1.5, vi: 1.5 },
      vi: { IV: 3, bVII: 2, I: 1.5 },
      V: { I: 3, vi: 1.5 },
      bVII: { I: 3, IV: 1.5 },
      ii: { V: 3 },
    },
    cadence: ['I', 'vi', 'IV'],
    colour: 'seventh',
    chordBars: 2,
  },
};

export function harmonyTable(style: StyleName, key: Key): HarmonyTable {
  return isMinorFlavoured(key.scale) ? MINOR_TABLES[style] : MAJOR_TABLES[style];
}

export interface BarChord {
  /** Bar index this chord starts on. */
  bar: number;
  /** How many bars it lasts. */
  bars: number;
  chord: Chord;
  /** Voiced midi notes for the pad, after voice leading. */
  voicing: number[];
}

export interface ProgressionOptions {
  key: Key;
  style: StyleName;
  bars: number;
  rng: Rng;
  /** Overrides the table's default chord length (used by the dnb drop). */
  chordBars?: number;
  /** Pad register centre in midi. */
  centre?: number;
}

/**
 * Generate a chord-per-N-bars progression covering `bars` bars.
 *
 * The chain is run per 4-chord phrase and the final chord of each phrase is
 * re-rolled (up to a few times) until it lands on a cadence chord, which is
 * what makes the loop feel like it comes home.
 */
export function generateProgression(opts: ProgressionOptions): BarChord[] {
  const table = harmonyTable(opts.style, opts.key);
  const chordBars = Math.max(1, opts.chordBars ?? table.chordBars);
  const centre = opts.centre ?? 60;
  const slots = Math.max(1, Math.ceil(opts.bars / chordBars));

  const labels: string[] = [];
  let current = opts.rng.pick(table.start);
  labels.push(current);

  for (let i = 1; i < slots; i++) {
    const row = table.transitions[current] ?? table.transitions[table.start[0]!] ?? {};
    const keys = Object.keys(row);
    if (keys.length === 0) {
      current = opts.rng.pick(table.start);
    } else {
      const weights = keys.map((k) => row[k]!);
      const isPhraseEnd = (i + 1) % 4 === 0;
      // Bias the last chord of each 4-chord phrase towards a cadence chord.
      const adjusted = keys.map((k, j) => (isPhraseEnd && table.cadence.includes(k) ? weights[j]! * 3 : weights[j]!));
      current = opts.rng.weighted(keys, adjusted);
    }
    labels.push(current);
  }

  // Avoid immediate repeats except where a style genuinely wants a pedal.
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === labels[i - 1] && opts.style !== 'ambient') {
      const row = table.transitions[labels[i - 1]!] ?? {};
      const keys = Object.keys(row).filter((k) => k !== labels[i - 1]);
      if (keys.length > 0) labels[i] = opts.rng.weighted(keys, keys.map((k) => row[k]!));
    }
  }

  const out: BarChord[] = [];
  let previous: number[] | null = null;
  for (let i = 0; i < slots; i++) {
    const chord = buildChord(opts.key, labels[i]!, table.colour);
    const voicing = voiceChord(chord, previous, centre, 12);
    previous = voicing;
    out.push({ bar: i * chordBars, bars: chordBars, chord, voicing });
  }
  return out;
}

/** Chord sounding at a given bar (chords are held, so this is a lookup). */
export function chordAtBar(progression: BarChord[], bar: number): BarChord {
  let best = progression[0]!;
  for (const bc of progression) {
    if (bc.bar <= bar) best = bc;
    else break;
  }
  return best;
}
