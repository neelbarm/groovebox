/**
 * Music theory primitives: pitch classes, scales, diatonic chords with
 * extensions, voice leading and Camelot key codes.
 *
 * Everything here is pure and side-effect free so the browser build and the
 * Node CLI agree exactly.
 */

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Preferred spellings for flat-side keys, used only for display. */
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export type ScaleName = 'major' | 'minor' | 'dorian' | 'mixolydian' | 'pentatonic';

export const SCALES: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  // Minor pentatonic -- five notes, used for melodic material in ambient/dnb.
  pentatonic: [0, 3, 5, 7, 10],
};

/** Scales whose tonic triad is minor. Drives Camelot letter and chord tables. */
const MINOR_FLAVOURED: ReadonlySet<ScaleName> = new Set<ScaleName>(['minor', 'dorian', 'pentatonic']);

export function isMinorFlavoured(scale: ScaleName): boolean {
  return MINOR_FLAVOURED.has(scale);
}

export interface Key {
  /** Tonic pitch class, 0 = C. */
  tonic: number;
  scale: ScaleName;
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function pitchName(pc: number, preferFlats = false): string {
  const i = mod(pc, 12);
  return preferFlats ? FLAT_NAMES[i]! : PITCH_NAMES[i]!;
}

/** Absolute pitch classes of a key's scale, ascending from the tonic. */
export function scalePitches(key: Key): number[] {
  return SCALES[key.scale].map((iv) => mod(key.tonic + iv, 12));
}

/** Human key name, e.g. "Am", "F maj", "D dorian". */
export function keyName(key: Key): string {
  const flats = usesFlats(key);
  const root = pitchName(key.tonic, flats);
  switch (key.scale) {
    case 'major':
      return `${root} major`;
    case 'minor':
      return `${root} minor`;
    case 'pentatonic':
      return `${root} minor pentatonic`;
    default:
      return `${root} ${key.scale}`;
  }
}

/** Short DJ-style label, e.g. "Am" / "F". */
export function shortKeyName(key: Key): string {
  const root = pitchName(key.tonic, usesFlats(key));
  return isMinorFlavoured(key.scale) ? `${root}m` : root;
}

function usesFlats(key: Key): boolean {
  // Keys on the flat side of the circle of fifths read better with flats.
  const parent = parentMajor(key);
  return [1, 3, 5, 8, 10].includes(parent) || (parent === 5 && true);
}

/**
 * The major key whose note collection matches this key.
 * A minor -> C major, D dorian -> C major, G mixolydian -> C major.
 */
export function parentMajor(key: Key): number {
  switch (key.scale) {
    case 'major':
      return mod(key.tonic, 12);
    case 'minor':
    case 'pentatonic':
      return mod(key.tonic + 3, 12);
    case 'dorian':
      return mod(key.tonic - 2, 12);
    case 'mixolydian':
      return mod(key.tonic - 7, 12);
  }
}

/**
 * Camelot wheel code. Relative major and minor share a number and differ only
 * in the letter, so we derive the number from the parent major's position on
 * the circle of fifths and pick the letter from the mode's flavour.
 *
 * C major -> 8B, A minor -> 8A, G major -> 9B.
 */
export function camelot(key: Key): string {
  const major = parentMajor(key);
  // Circle of fifths order starting at C => index 0; Camelot puts C at 8B.
  const fifths = mod(major * 7, 12); // number of fifths from C
  const number = mod(fifths + 7, 12) + 1; // C(0) -> 8
  const letter = isMinorFlavoured(key.scale) ? 'A' : 'B';
  return `${number}${letter}`;
}

/**
 * The standard major/minor key that shares this key's Camelot position.
 *
 * For plain major/minor this is just the key itself. For a mode it is the
 * relative major or minor of the same note collection: D dorian reports "Am",
 * because that is the key a DJ tool would call 8A. Reported alongside `key`
 * so a "Dm" labelled 8A never looks like a bug.
 */
export function camelotKey(key: Key): string {
  const major = parentMajor(key);
  return isMinorFlavoured(key.scale)
    ? `${pitchName(mod(major + 9, 12), usesFlats(key))}m`
    : pitchName(major, usesFlats(key));
}

/** Parse "Am", "F#m", "Bb", "C major", "D dorian" into a Key. */
export function parseKey(input: string): Key {
  const text = input.trim();
  const m = /^([A-Ga-g])([#b♯♭]?)\s*(.*)$/.exec(text);
  if (!m) throw new Error(`Cannot parse key: "${input}"`);
  const letter = m[1]!.toUpperCase();
  const accidental = m[2] ?? '';
  const rest = (m[3] ?? '').trim().toLowerCase();

  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let tonic = base[letter]!;
  if (accidental === '#' || accidental === '♯') tonic += 1;
  if (accidental === 'b' || accidental === '♭') tonic -= 1;
  tonic = mod(tonic, 12);

  let scale: ScaleName = 'major';
  if (rest === '' || rest === 'maj' || rest === 'major' || rest === 'M') scale = 'major';
  else if (rest === 'm' || rest === 'min' || rest === 'minor') scale = 'minor';
  else if (rest === 'dorian' || rest === 'dor') scale = 'dorian';
  else if (rest === 'mixolydian' || rest === 'mixo') scale = 'mixolydian';
  else if (rest === 'pent' || rest === 'pentatonic') scale = 'pentatonic';
  else throw new Error(`Unknown mode "${rest}" in key "${input}"`);

  return { tonic, scale };
}

/* ------------------------------------------------------------------ chords */

export interface Chord {
  /** Roman-numeral function label, e.g. "i7", "V7", "bVII". */
  label: string;
  /** Root pitch class. */
  root: number;
  /** Intervals above the root in semitones, always starting with 0. */
  intervals: number[];
  /** Display name, e.g. "Am9". */
  name: string;
  /** Chord tones as pitch classes (unordered set, deduplicated). */
  pitchClasses: number[];
}

interface ChordShape {
  /** Semitones above the tonic. */
  offset: number;
  /** Triad/seventh intervals. */
  intervals: number[];
  /** Suffix used when naming, e.g. "m7". */
  suffix: string;
}

const TRIAD = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus4: [0, 5, 7],
};

/**
 * Chord vocabulary keyed by roman-numeral label. Uppercase = major-ish,
 * lowercase = minor-ish, a leading "b" means borrowed/flattened degree.
 * Offsets are relative to the *tonic of the key*, so the same table serves
 * major and minor keys -- the harmony tables simply pick different labels.
 */
export const CHORD_SHAPES: Record<string, ChordShape> = {
  // Major-key diatonic
  I: { offset: 0, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  ii: { offset: 2, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  iii: { offset: 4, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  IV: { offset: 5, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  V: { offset: 7, intervals: [...TRIAD.maj, 10], suffix: '7' },
  vi: { offset: 9, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  viio: { offset: 11, intervals: [...TRIAD.dim, 10], suffix: 'm7b5' },

  // Minor-key diatonic (natural minor)
  i: { offset: 0, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  iio: { offset: 2, intervals: [...TRIAD.dim, 10], suffix: 'm7b5' },
  III: { offset: 3, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  iv: { offset: 5, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  v: { offset: 7, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  VI: { offset: 8, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  VII: { offset: 10, intervals: [...TRIAD.maj, 10], suffix: '7' },

  // Borrowed / colour chords
  bVII: { offset: 10, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  bVI: { offset: 8, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  bIII: { offset: 3, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  IVm: { offset: 5, intervals: [...TRIAD.min, 10], suffix: 'm7' },
  Isus: { offset: 0, intervals: [...TRIAD.sus4, 10], suffix: '7sus4' },
  Vsus: { offset: 7, intervals: [...TRIAD.sus4, 10], suffix: '7sus4' },
  ivsus: { offset: 5, intervals: [...TRIAD.sus4, 10], suffix: '7sus4' },
  IIdom: { offset: 2, intervals: [...TRIAD.maj, 10], suffix: '7' },
  bIImaj: { offset: 1, intervals: [...TRIAD.maj, 11], suffix: 'maj7' },
  Iaug: { offset: 0, intervals: [...TRIAD.aug, 10], suffix: 'aug7' },
};

export type ChordColour = 'triad' | 'seventh' | 'ninth';

/** Build a concrete chord from a roman-numeral label in a given key. */
export function buildChord(key: Key, label: string, colour: ChordColour = 'seventh'): Chord {
  const shape = CHORD_SHAPES[label];
  if (!shape) throw new Error(`Unknown chord label "${label}"`);
  const root = mod(key.tonic + shape.offset, 12);

  let intervals = shape.intervals.slice();
  let suffix = shape.suffix;

  if (colour === 'triad') {
    intervals = intervals.slice(0, 3);
    suffix = suffix.startsWith('m7b5') ? 'dim' : suffix.startsWith('m') ? 'm' : suffix === '7sus4' ? 'sus4' : '';
  } else if (colour === 'ninth') {
    // A 9th is the 2nd, an octave up. Major/minor 9 for everything except
    // half-diminished, which gets a plain 11th-free voicing instead.
    if (!suffix.includes('b5')) {
      intervals = [...intervals, 14];
      suffix = suffix === 'maj7' ? 'maj9' : suffix === 'm7' ? 'm9' : suffix === '7' ? '9' : suffix === '7sus4' ? '9sus4' : suffix;
    }
  }

  const flats = usesFlats(key);
  const name = `${pitchName(root, flats)}${suffix}`;
  const pitchClasses = [...new Set(intervals.map((iv) => mod(root + iv, 12)))];

  return { label, root, intervals, name, pitchClasses };
}

/* ----------------------------------------------------------- voice leading */

/**
 * Choose the chord voicing (inversion + octave) whose notes move least from
 * the previous voicing. This is what stops a pad from jumping an octave every
 * bar; it is the cheapest possible approximation of real voice leading and it
 * sounds dramatically better than naive root-position stacking.
 */
export function voiceChord(chord: Chord, previous: number[] | null, centre = 60, spread = 12): number[] {
  const candidates = enumerateVoicings(chord, centre, spread);
  if (candidates.length === 0) return chord.intervals.map((iv) => centre + iv);
  if (!previous || previous.length === 0) {
    // Without history, prefer the voicing closest to the target centre.
    let best = candidates[0]!;
    let bestCost = Infinity;
    for (const cand of candidates) {
      const cost = Math.abs(average(cand) - centre);
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    return best;
  }

  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const cand of candidates) {
    const cost = voicingDistance(previous, cand) + Math.abs(average(cand) - centre) * 0.25;
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best;
}

/** Sum of the distance from each note of `b` to its nearest note in `a`, plus register drift. */
export function voicingDistance(a: number[], b: number[]): number {
  let total = 0;
  for (const note of b) {
    let nearest = Infinity;
    for (const prev of a) nearest = Math.min(nearest, Math.abs(note - prev));
    total += nearest;
  }
  return total / Math.max(1, b.length);
}

function enumerateVoicings(chord: Chord, centre: number, spread: number): number[][] {
  const out: number[][] = [];
  const base = chord.intervals.slice().sort((x, y) => x - y);
  // Try every rotation (inversion) across a couple of octaves near the centre.
  for (let rot = 0; rot < base.length; rot++) {
    const rotated = base.map((_, i) => {
      const idx = (rot + i) % base.length;
      const raise = rot + i >= base.length ? 12 : 0;
      return base[idx]! + raise;
    });
    for (let oct = -2; oct <= 2; oct++) {
      const root = chord.root + 12 * (Math.round((centre - chord.root) / 12) + oct);
      const voicing = rotated.map((iv) => root + iv).sort((x, y) => x - y);
      const lo = voicing[0]!;
      const hi = voicing[voicing.length - 1]!;
      if (hi - lo > spread + 14) continue;
      if (lo < centre - spread - 8 || hi > centre + spread + 10) continue;
      out.push(voicing);
    }
  }
  return out;
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/* -------------------------------------------------------------- utilities */

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiName(midi: number): string {
  return `${pitchName(mod(midi, 12))}${Math.floor(midi / 12) - 1}`;
}

/** Snap a midi note to the nearest member of a pitch-class set, preferring upward. */
export function snapToPitchClasses(midi: number, pcs: readonly number[]): number {
  if (pcs.length === 0) return midi;
  for (let d = 0; d <= 6; d++) {
    for (const dir of d === 0 ? [0] : [-d, d]) {
      const cand = midi + dir;
      if (pcs.includes(mod(cand, 12))) return cand;
    }
  }
  return midi;
}

/** Nearest midi note above `floorNote` with the given pitch class. */
export function pitchClassAbove(pc: number, floorNote: number): number {
  const delta = mod(pc - mod(floorNote, 12), 12);
  return floorNote + delta;
}

/** Scale degrees of a key as midi offsets covering several octaves. */
export function scaleLadder(key: Key, lowMidi: number, highMidi: number): number[] {
  const pcs = scalePitches(key);
  const out: number[] = [];
  for (let n = lowMidi; n <= highMidi; n++) {
    if (pcs.includes(mod(n, 12))) out.push(n);
  }
  return out;
}
