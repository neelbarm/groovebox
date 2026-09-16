/**
 * The session JSON: the handoff format.
 *
 * groovebox writes it next to every track so a DJ tool (MixPilot, in our case)
 * never has to analyse the audio -- it already knows the tempo, the key, the
 * Camelot code for harmonic mixing, where each section starts and how the
 * energy moves. "I generated the songs, then my DJ mixed them."
 */

import type { ScaleName } from './theory.js';
import type { StyleName } from './styles.js';

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionSection {
  name: string;
  startBar: number;
  bars: number;
  startSec: number;
  durationSec: number;
  energy: number;
  layers: string[];
}

export interface SessionChord {
  bar: number;
  bars: number;
  startSec: number;
  /** Roman-numeral function, e.g. "iv7". */
  degree: string;
  /** Display name, e.g. "Dm9". */
  name: string;
  /** Pitch classes, 0 = C. */
  notes: number[];
  /** The actual voiced midi notes the pad plays. */
  voicing: number[];
}

export interface SessionStats {
  peakDb: number;
  rmsDb: number;
  sampleRate: number;
  frames: number;
}

export interface Session {
  schema: number;
  generator: string;
  seed: number;
  style: StyleName;
  bpm: number;
  /** Short DJ key label, e.g. "Am". */
  key: string;
  /** Long form, e.g. "A minor". */
  keyName: string;
  camelot: string;
  /**
   * The standard major/minor key matching `camelot`. Identical to `key` for
   * major/minor; for modal keys it names the relative key of the same note
   * collection (D dorian -> "Am"), so `key` and `camelot` never look at odds.
   */
  camelotKey: string;
  scale: ScaleName;
  bars: number;
  beatsPerBar: number;
  durationSec: number;
  sections: SessionSection[];
  chords: SessionChord[];
  /** One value per bar, 0..1. */
  energyCurve: number[];
  /** Beat grid in seconds -- downbeats only, for beat-matched cueing. */
  downbeats: number[];
  stats: SessionStats;
}

/** Runtime schema check, shared by the tests and anything ingesting a session. */
export function validateSession(value: unknown): asserts value is Session {
  const s = value as Session;
  const fail = (msg: string): never => {
    throw new Error(`Invalid session: ${msg}`);
  };
  if (typeof s !== 'object' || s === null) fail('not an object');
  if (s.schema !== SESSION_SCHEMA_VERSION) fail(`schema must be ${SESSION_SCHEMA_VERSION}`);
  for (const key of ['generator', 'style', 'key', 'keyName', 'camelot', 'camelotKey', 'scale'] as const) {
    if (typeof s[key] !== 'string' || s[key].length === 0) fail(`${key} must be a non-empty string`);
  }
  for (const key of ['seed', 'bpm', 'bars', 'beatsPerBar', 'durationSec'] as const) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key])) fail(`${key} must be a finite number`);
  }
  if (!/^(1[0-2]|[1-9])[AB]$/.test(s.camelot)) fail(`camelot "${s.camelot}" is not a wheel code`);
  if (!Array.isArray(s.sections) || s.sections.length === 0) fail('sections must be a non-empty array');
  if (!Array.isArray(s.chords) || s.chords.length === 0) fail('chords must be a non-empty array');
  if (!Array.isArray(s.energyCurve) || s.energyCurve.length !== s.bars) fail('energyCurve must have one entry per bar');
  if (!Array.isArray(s.downbeats) || s.downbeats.length !== s.bars) fail('downbeats must have one entry per bar');
  for (const e of s.energyCurve) {
    if (typeof e !== 'number' || e < 0 || e > 1) fail('energyCurve entries must be in 0..1');
  }
  for (const section of s.sections) {
    if (typeof section.name !== 'string' || typeof section.startBar !== 'number' || typeof section.bars !== 'number') {
      fail('malformed section');
    }
    if (!Array.isArray(section.layers)) fail('section.layers must be an array');
  }
  for (const chord of s.chords) {
    if (typeof chord.name !== 'string' || !Array.isArray(chord.notes) || !Array.isArray(chord.voicing)) fail('malformed chord');
    for (const n of chord.notes) {
      if (typeof n !== 'number' || n < 0 || n > 11) fail('chord.notes must be pitch classes 0..11');
    }
  }
  if (typeof s.stats !== 'object' || s.stats === null || typeof s.stats.peakDb !== 'number') fail('missing stats');
}
