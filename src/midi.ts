/**
 * Standard MIDI File writer (format 1: one tempo track plus a track per
 * instrument). Written by hand because the format is small and the whole point
 * of this project is that the pipeline has no black boxes.
 */

export interface MidiNote {
  /** Start in quarter-note beats. */
  beat: number;
  /** Length in beats. */
  dur: number;
  midi: number;
  /** 0..1 */
  vel: number;
}

export interface MidiTrackSpec {
  name: string;
  /** 0-15. Channel 9 is the GM drum channel. */
  channel: number;
  /** General MIDI program number, 0-127. Ignored on channel 9. */
  program: number;
  notes: MidiNote[];
}

export interface MidiFileSpec {
  bpm: number;
  /** Ticks per quarter note. */
  ppq?: number;
  tracks: MidiTrackSpec[];
  timeSignature?: [number, number];
}

/** MIDI variable-length quantity. */
export function writeVarLen(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const out = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return out;
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0x7f);
  return out;
}

function chunk(id: string, body: number[]): number[] {
  const len = body.length;
  return [...ascii(id), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
}

function trackName(name: string): number[] {
  const text = ascii(name);
  return [0x00, 0xff, 0x03, ...writeVarLen(text.length), ...text];
}

const END_OF_TRACK = [0x00, 0xff, 0x2f, 0x00];

export function encodeMidi(spec: MidiFileSpec): Uint8Array {
  const ppq = spec.ppq ?? 480;
  const header = chunk('MThd', [
    0x00, 0x01, // format 1
    ((spec.tracks.length + 1) >>> 8) & 0xff, (spec.tracks.length + 1) & 0xff,
    (ppq >>> 8) & 0xff, ppq & 0xff,
  ]);

  // Track 0: tempo + time signature only.
  const usPerQuarter = Math.round(60000000 / spec.bpm);
  const [num, den] = spec.timeSignature ?? [4, 4];
  const denPow = Math.round(Math.log2(den));
  const tempoTrack = chunk('MTrk', [
    ...trackName('groovebox'),
    0x00, 0xff, 0x51, 0x03, (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff,
    0x00, 0xff, 0x58, 0x04, num & 0xff, denPow & 0xff, 24, 8,
    ...END_OF_TRACK,
  ]);

  const trackChunks = spec.tracks.map((track) => {
    // Two note-ons for the same key before a note-off is ambiguous MIDI: most
    // sequencers drop one. Group by key, then clip each note so it always
    // releases before the next hit of that same key retriggers.
    const byKey = new Map<number, Array<{ on: number; off: number; velocity: number }>>();
    for (const note of track.notes) {
      const key = Math.max(0, Math.min(127, Math.round(note.midi)));
      const on = Math.max(0, Math.round(note.beat * ppq));
      const off = Math.max(on + 1, Math.round((note.beat + note.dur) * ppq));
      const velocity = Math.max(1, Math.min(127, Math.round(note.vel * 127)));
      const list = byKey.get(key);
      if (list) list.push({ on, off, velocity });
      else byKey.set(key, [{ on, off, velocity }]);
    }

    const events: Array<{ tick: number; order: number; data: number[] }> = [];
    for (const [key, notes] of byKey) {
      notes.sort((a, b) => a.on - b.on || a.off - b.off);
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i]!;
        const next = notes[i + 1];
        // Exact duplicates (two humanised hits landing on the same tick) collapse.
        if (next && next.on <= note.on) continue;
        const off = next ? Math.min(note.off, next.on - 1) : note.off;
        if (off <= note.on) continue;
        events.push({ tick: note.on, order: 1, data: [0x90 | (track.channel & 0x0f), key, note.velocity] });
        events.push({ tick: off, order: 0, data: [0x80 | (track.channel & 0x0f), key, 0x40] });
      }
    }
    // Note-offs sort before note-ons at the same tick so repeated notes retrigger.
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const body: number[] = [...trackName(track.name)];
    if (track.channel !== 9) {
      body.push(0x00, 0xc0 | (track.channel & 0x0f), Math.max(0, Math.min(127, track.program)));
    }
    let last = 0;
    for (const ev of events) {
      body.push(...writeVarLen(ev.tick - last), ...ev.data);
      last = ev.tick;
    }
    body.push(...END_OF_TRACK);
    return chunk('MTrk', body);
  });

  const all = [...header, ...tempoTrack, ...trackChunks.flat()];
  return Uint8Array.from(all);
}
