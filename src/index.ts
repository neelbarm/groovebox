/**
 * groovebox -- deterministic generative music in pure TypeScript.
 *
 *   import { generate, toWav, toMidi } from 'groovebox';
 *   const track = generate({ seed: 42, style: 'lofi', bars: 32 });
 *   const wav = toWav(track);       // Uint8Array, 16-bit stereo RIFF
 *   const mid = toMidi(track);      // Uint8Array, SMF format 1
 *   track.session;                  // DJ-ready metadata (bpm, key, camelot...)
 *
 * The same module runs unmodified in Node and in the browser.
 */

export * from './rng.js';
export * from './theory.js';
export * from './styles.js';
export * from './harmony.js';
export * from './structure.js';
export * from './rhythm.js';
export * from './dsp.js';
export * from './synth.js';
export * from './wav.js';
export * from './midi.js';
export * from './session.js';
export * from './generate.js';

import type { GenerateResult } from './generate.js';
import { encodeWav } from './wav.js';
import { MidiFileSpec, MidiTrackSpec, encodeMidi } from './midi.js';
import type { DrumType } from './rhythm.js';
import type { StyleName } from './styles.js';

/** Encode the rendered audio as a 16-bit stereo WAV. */
export function toWav(result: GenerateResult): Uint8Array {
  return encodeWav(result.audio);
}

/** General MIDI percussion key numbers. */
const GM_DRUM: Record<DrumType, number> = {
  kick: 36,
  snare: 38,
  clap: 39,
  hat: 42,
  ohat: 46,
  ride: 51,
  rim: 37,
};

/** General MIDI programs picked to be roughly recognisable per style. */
const GM_PROGRAMS: Record<StyleName, { pad: number; bass: number; lead: number }> = {
  lofi: { pad: 4, bass: 33, lead: 11 }, // Rhodes, finger bass, vibraphone
  house: { pad: 89, bass: 38, lead: 81 }, // warm pad, synth bass, square lead
  ambient: { pad: 89, bass: 33, lead: 91 }, // warm pad, finger bass, polysynth
  dnb: { pad: 90, bass: 39, lead: 81 }, // polysynth pad, synth bass 2, square lead
};

/** Build the MIDI file spec (format 1, one track per instrument + tempo track). */
export function toMidiSpec(result: GenerateResult): MidiFileSpec {
  const programs = GM_PROGRAMS[result.style];
  const tracks: MidiTrackSpec[] = [
    {
      name: 'Pad',
      channel: 0,
      program: programs.pad,
      notes: result.score.pad.map((n) => ({ beat: n.beat, dur: n.dur, midi: n.midi, vel: n.vel })),
    },
    {
      name: 'Bass',
      channel: 1,
      program: programs.bass,
      notes: result.score.bass.map((n) => ({ beat: n.beat, dur: n.dur, midi: n.midi, vel: n.vel })),
    },
    {
      name: 'Lead',
      channel: 2,
      program: programs.lead,
      notes: result.score.lead.map((n) => ({ beat: n.beat, dur: n.dur, midi: n.midi, vel: n.vel })),
    },
    {
      name: 'Drums',
      channel: 9,
      program: 0,
      notes: result.score.drums.map((h) => ({ beat: h.beat, dur: 0.12, midi: GM_DRUM[h.type], vel: h.vel })),
    },
  ];
  return { bpm: result.bpm, ppq: 480, tracks, timeSignature: [4, 4] };
}

/** Encode the score as a standard MIDI file. */
export function toMidi(result: GenerateResult): Uint8Array {
  return encodeMidi(toMidiSpec(result));
}

/** Pretty JSON for the session sidecar file. */
export function toSessionJson(result: GenerateResult): string {
  return `${JSON.stringify(result.session, null, 2)}\n`;
}
