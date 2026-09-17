/**
 * Engine tests: determinism, music theory, and the two binary formats we
 * write by hand. Run with `npm test` (which builds first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generate,
  toWav,
  toMidi,
  toMidiSpec,
  encodeWav,
  readWavInfo,
  WAV_HEADER_BYTES,
  writeVarLen,
  validateSession,
  SESSION_SCHEMA_VERSION,
  buildChord,
  voiceChord,
  voicingDistance,
  camelot,
  camelotKey,
  parseKey,
  keyName,
  shortKeyName,
  scalePitches,
  mod,
  STYLE_NAMES,
  Rng,
  streamFor,
  generateProgression,
  buildStructure,
  energyCurve,
  peakOf,
  rmsOf,
  dbfs,
} from '../dist/index.js';

import { readMidi } from './midi-reader.js';

/** Small + cheap: enough music to be meaningful, fast enough to run often. */
const FAST = { bars: 8, sampleRate: 22050 };

/* ========================================================== determinism == */

test('same seed produces a byte-identical WAV', () => {
  const a = toWav(generate({ seed: 42, style: 'lofi', ...FAST }));
  const b = toWav(generate({ seed: 42, style: 'lofi', ...FAST }));
  assert.equal(a.length, b.length, 'lengths differ');
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), 'same seed must be byte-identical');
});

test('different seeds produce different audio', () => {
  const a = toWav(generate({ seed: 42, style: 'lofi', ...FAST }));
  const b = toWav(generate({ seed: 43, style: 'lofi', ...FAST }));
  assert.ok(!Buffer.from(a).equals(Buffer.from(b)), 'seed 42 and 43 must differ');
});

test('determinism holds for every style, and styles differ from each other', () => {
  const digests = new Map();
  for (const style of STYLE_NAMES) {
    const first = toWav(generate({ seed: 5, style, ...FAST }));
    const second = toWav(generate({ seed: 5, style, ...FAST }));
    assert.ok(Buffer.from(first).equals(Buffer.from(second)), `${style} is not deterministic`);
    digests.set(style, Buffer.from(first).toString('base64').slice(0, 512));
  }
  assert.equal(new Set(digests.values()).size, STYLE_NAMES.length, 'styles must not render identically');
});

test('the PRNG stream is reproducible and reasonably uniform', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  const mean = sum / 20000;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean} is not near 0.5`);
  // Forked streams must be independent but reproducible.
  assert.equal(streamFor(7, 'drums').next(), streamFor(7, 'drums').next());
  assert.notEqual(streamFor(7, 'drums').next(), streamFor(7, 'bass').next());
});

/* =============================================================== theory == */

test('parseKey / keyName / Camelot round-trip on known keys', () => {
  assert.deepEqual(parseKey('Am'), { tonic: 9, scale: 'minor' });
  assert.deepEqual(parseKey('F#m'), { tonic: 6, scale: 'minor' });
  assert.deepEqual(parseKey('Bb'), { tonic: 10, scale: 'major' });
  assert.deepEqual(parseKey('D dorian'), { tonic: 2, scale: 'dorian' });
  assert.equal(shortKeyName(parseKey('Am')), 'Am');
  // A mode reports its own tonic, plus the standard key sharing its Camelot slot.
  assert.equal(shortKeyName(parseKey('D dorian')), 'Dm');
  assert.equal(camelotKey(parseKey('D dorian')), 'Am');
  assert.equal(camelot(parseKey('D dorian')), camelot(parseKey('Am')));
  assert.equal(camelotKey(parseKey('Am')), 'Am');
  assert.equal(camelotKey(parseKey('C major')), 'C');
  assert.equal(keyName(parseKey('C major')), 'C major');
  assert.throws(() => parseKey('H minor'));
  assert.throws(() => parseKey('C lydian'));

  // Camelot: relative major/minor share a number, differ by letter.
  assert.equal(camelot({ tonic: 0, scale: 'major' }), '8B'); // C major
  assert.equal(camelot({ tonic: 9, scale: 'minor' }), '8A'); // A minor
  assert.equal(camelot({ tonic: 7, scale: 'major' }), '9B'); // G major
  assert.equal(camelot({ tonic: 4, scale: 'minor' }), '9A'); // E minor
  assert.equal(camelot({ tonic: 5, scale: 'major' }), '7B'); // F major
  assert.equal(camelot({ tonic: 2, scale: 'minor' }), '7A'); // D minor
});

test('every Camelot code is a valid wheel position', () => {
  const seen = new Set();
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const scale of ['major', 'minor']) {
      const code = camelot({ tonic, scale });
      assert.match(code, /^(1[0-2]|[1-9])[AB]$/);
      seen.add(code);
    }
  }
  assert.equal(seen.size, 24, 'the 24 keys must map onto the 24 wheel positions');
});

test('generated chords use only tones from the key (or documented borrowings)', () => {
  for (const style of STYLE_NAMES) {
    for (const seed of [1, 17, 404]) {
      const result = generate({ seed, style, ...FAST });
      const inScale = new Set(scalePitches(result.key));
      let borrowed = 0;
      let total = 0;
      for (const chord of result.session.chords) {
        for (const note of chord.notes) {
          total++;
          if (!inScale.has(note)) borrowed++;
        }
        // The written notes must actually be the chord the label names.
        const rebuilt = buildChord(result.key, chord.degree, 'seventh');
        assert.ok(chord.notes.includes(rebuilt.root), `${chord.name} is missing its own root`);
        for (const pc of rebuilt.pitchClasses) {
          assert.ok(chord.notes.includes(pc), `${chord.name} is missing chord tone ${pc}`);
        }
        assert.ok(chord.voicing.every((n) => chord.notes.includes(mod(n, 12))), `${chord.name}: voicing left the chord`);
      }
      // Borrowed colour chords are deliberate, but they must stay a minority.
      assert.ok(borrowed / total < 0.25, `${style}/${seed}: ${borrowed}/${total} non-diatonic tones is too many`);
    }
  }
});

test('chord tones on strong beats: melody notes on beats 1 and 3 belong to the chord', () => {
  for (const style of STYLE_NAMES) {
    const result = generate({ seed: 11, style, bars: 16, sampleRate: 22050 });
    let checked = 0;
    for (const note of result.score.lead) {
      const beatInBar = note.beat % 4;
      const isStrong = Math.abs(beatInBar % 2) < 1e-6;
      if (!isStrong) continue;
      const bar = Math.floor(note.beat / 4);
      let chord = result.session.chords[0];
      for (const c of result.session.chords) if (c.bar <= bar) chord = c;
      assert.ok(
        chord.notes.includes(mod(note.midi, 12)),
        `${style}: strong-beat note ${note.midi} not in ${chord.name} [${chord.notes}]`,
      );
      checked++;
    }
    assert.ok(checked > 0, `${style}: no strong-beat melody notes to check`);
  }
});

test('voice leading keeps chord-to-chord movement small', () => {
  const key = parseKey('Am');
  const labels = ['i', 'iv', 'VII', 'III', 'VI', 'iio', 'V', 'i'];
  let previous = null;
  let worst = 0;
  for (const label of labels) {
    const chord = buildChord(key, label, 'seventh');
    const voicing = voiceChord(chord, previous, 60, 12);
    assert.equal(voicing.length, chord.intervals.length);
    for (const note of voicing) assert.ok(note > 24 && note < 100, `voicing note ${note} out of register`);
    if (previous) worst = Math.max(worst, voicingDistance(previous, voicing));
    previous = voicing;
  }
  assert.ok(worst <= 4, `average voice movement peaked at ${worst} semitones, expected <= 4`);
});

test('generated progressions also keep voice movement bounded', () => {
  for (const style of STYLE_NAMES) {
    const progression = generateProgression({
      key: parseKey('Am'),
      style,
      bars: 32,
      rng: streamFor(3, 'test'),
    });
    assert.ok(progression.length >= 4);
    for (let i = 1; i < progression.length; i++) {
      const move = voicingDistance(progression[i - 1].voicing, progression[i].voicing);
      assert.ok(move <= 5, `${style}: chord ${i} moved ${move} semitones on average`);
    }
  }
});

/* ============================================================= structure == */

test('structure covers exactly the requested bars with no gaps', () => {
  for (const style of STYLE_NAMES) {
    for (const bars of [8, 16, 32, 48, 64]) {
      const sections = buildStructure(style, bars, streamFor(9, `form-${bars}`));
      let cursor = 0;
      for (const section of sections) {
        assert.equal(section.startBar, cursor, `${style}/${bars}: gap before "${section.name}"`);
        assert.ok(section.bars > 0);
        cursor += section.bars;
      }
      assert.equal(cursor, bars, `${style}/${bars}: sections sum to ${cursor}`);
      assert.equal(energyCurve(sections, bars).length, bars);
    }
  }
});

test('structure fits inside the shortest songs the CLI allows', () => {
  // `--bars 4` is legal, but every template has more sections than that, and
  // each section has a minimum length: the allocation must be clipped, never
  // allowed to describe more bars than the track actually contains.
  for (const style of STYLE_NAMES) {
    for (let bars = 4; bars <= 12; bars++) {
      const sections = buildStructure(style, bars, streamFor(9, `short-${bars}`));
      assert.ok(sections.length > 0, `${style}/${bars}: no sections`);
      let cursor = 0;
      for (const section of sections) {
        assert.equal(section.startBar, cursor, `${style}/${bars}: gap before "${section.name}"`);
        assert.ok(section.bars > 0, `${style}/${bars}: "${section.name}" is empty`);
        cursor += section.bars;
      }
      assert.equal(cursor, bars, `${style}/${bars}: sections span ${cursor} bars, not ${bars}`);
      assert.equal(sections.filter((s) => s.isOutro).length, 1, `${style}/${bars}: exactly one section fades`);
      assert.ok(sections[sections.length - 1].isOutro, `${style}/${bars}: the fade must be the last section`);
      assert.equal(energyCurve(sections, bars).length, bars);
    }
  }
});

test('a four-bar track still reports a truthful session', () => {
  for (const style of STYLE_NAMES) {
    const session = generate({ seed: 6, style, bars: 4, sampleRate: 22050 }).session;
    assert.doesNotThrow(() => validateSession(JSON.parse(JSON.stringify(session))));
    let cursor = 0;
    for (const section of session.sections) {
      assert.equal(section.startBar, cursor, `${style}: section gap at bar ${cursor}`);
      cursor += section.bars;
    }
    assert.equal(cursor, session.bars, `${style}: sections claim ${cursor} bars of a ${session.bars}-bar track`);
    const barSeconds = (60 / session.bpm) * 4;
    const last = session.sections[session.sections.length - 1];
    assert.ok(
      last.startSec + last.durationSec <= session.durationSec + 1e-6,
      `${style}: the last section ends after the audio does`,
    );
    for (const chord of session.chords) {
      assert.ok(chord.bar < session.bars, `${style}: chord at bar ${chord.bar} is past the end`);
      assert.ok(chord.startSec < session.bars * barSeconds + 1e-6);
    }
  }
});

/* =================================================================== wav == */

test('WAV header fields are correct and the data length matches', () => {
  const result = generate({ seed: 2, style: 'house', bars: 8, sampleRate: 44100 });
  const bytes = toWav(result);
  const info = readWavInfo(bytes);

  assert.equal(info.audioFormat, 1, 'must be PCM');
  assert.equal(info.channels, 2);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.blockAlign, 4);
  assert.equal(info.byteRate, 44100 * 4);
  assert.equal(info.frames, result.audio.left.length);
  assert.equal(info.dataBytes, result.audio.left.length * 4);
  assert.equal(bytes.length, WAV_HEADER_BYTES + info.dataBytes);
  assert.equal(info.riffSize, bytes.length - 8);
});

test('the encoder honours a non-default sample rate', () => {
  const buffer = { left: new Float32Array(100), right: new Float32Array(100), sampleRate: 48000 };
  const info = readWavInfo(encodeWav(buffer));
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.byteRate, 48000 * 4);
  assert.equal(info.frames, 100);
});

test('no sample exceeds 1.0 and the peak lands between -6 and -0.1 dBFS', () => {
  for (const style of STYLE_NAMES) {
    const result = generate({ seed: 77, style, bars: 16, sampleRate: 22050 });
    const { left, right } = result.audio;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(left[i]) <= 1.0, `${style}: left sample ${i} = ${left[i]}`);
      assert.ok(Math.abs(right[i]) <= 1.0, `${style}: right sample ${i} = ${right[i]}`);
    }
    const peakDb = dbfs(peakOf(result.audio));
    assert.ok(peakDb <= -0.1, `${style}: peak ${peakDb.toFixed(2)} dBFS is too hot`);
    assert.ok(peakDb >= -6, `${style}: peak ${peakDb.toFixed(2)} dBFS is too quiet`);
    const rmsDb = dbfs(rmsOf(result.audio));
    assert.ok(rmsDb < peakDb, `${style}: rms must sit below peak`);
    assert.ok(rmsDb > -30, `${style}: rms ${rmsDb.toFixed(1)} dBFS suggests a near-silent track`);
  }
});

test('a seed sweep never leaks a non-finite sample, a clip, or a broken file', () => {
  // One render per (seed, style); every invariant that has to hold for *all*
  // output is checked on it. A single NaN anywhere in the chain (a filter
  // blowing up, a divide by zero in an envelope) silently becomes a zero
  // sample in the WAV, so it has to be caught here rather than by ear.
  for (let seed = 0; seed < 20; seed++) {
    for (const style of STYLE_NAMES) {
      const where = `seed ${seed} / ${style}`;
      const result = generate({ seed, style, bars: 8, sampleRate: 22050 });
      const { left, right } = result.audio;

      for (let i = 0; i < left.length; i++) {
        const l = left[i];
        const r = right[i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) {
          assert.fail(`${where}: non-finite sample at frame ${i} (${l}, ${r})`);
        }
        if (Math.abs(l) > 1 || Math.abs(r) > 1) {
          assert.fail(`${where}: sample ${i} exceeds full scale (${l}, ${r})`);
        }
      }

      for (const [name, value] of Object.entries(result.session.stats)) {
        assert.ok(Number.isFinite(value), `${where}: stats.${name} is ${value}`);
      }
      assert.ok(!JSON.stringify(result.session).includes('null'), `${where}: session JSON has a null`);

      const wav = toWav(result);
      const info = readWavInfo(wav);
      assert.equal(info.dataBytes % 2, 0, `${where}: odd WAV data chunk`);
      assert.equal(info.dataBytes, wav.length - WAV_HEADER_BYTES, `${where}: data chunk vs file size`);
      assert.equal(info.riffSize, wav.length - 8, `${where}: RIFF size vs file size`);
      assert.equal(info.frames, left.length, `${where}: frame count`);

      const midi = readMidi(toMidi(result));
      assert.equal(midi.tempoBpm, result.bpm, `${where}: MIDI tempo`);
      for (const track of midi.tracks) {
        assert.equal(track.danglingNoteOns, 0, `${where}: ${track.name} left a note hanging`);
        for (const note of track.notes) {
          assert.ok(note.durationTicks > 0, `${where}: ${track.name} has a zero-length note`);
          assert.ok(note.startTick >= 0, `${where}: ${track.name} has a negative start tick`);
          assert.ok(note.velocity >= 1 && note.velocity <= 127, `${where}: ${track.name} velocity ${note.velocity}`);
        }
      }
    }
  }
});

test('the track ends in silence (the fade actually runs)', () => {
  const result = generate({ seed: 4, style: 'lofi', bars: 8, sampleRate: 22050 });
  const { left, right } = result.audio;
  const tail = 64;
  for (let i = left.length - tail; i < left.length; i++) {
    assert.ok(Math.abs(left[i]) < 1e-3 && Math.abs(right[i]) < 1e-3, `sample ${i} is not silent`);
  }
});

/* ================================================================== midi == */

test('variable-length quantities round-trip', () => {
  assert.deepEqual(writeVarLen(0), [0x00]);
  assert.deepEqual(writeVarLen(127), [0x7f]);
  assert.deepEqual(writeVarLen(128), [0x81, 0x00]);
  assert.deepEqual(writeVarLen(8192), [0xc0, 0x00]);
  assert.deepEqual(writeVarLen(1048576), [0xc0, 0x80, 0x00]);
});

test('the MIDI file parses back with the right tempo and note counts', () => {
  const result = generate({ seed: 12, style: 'lofi', bars: 16, sampleRate: 22050 });
  const parsed = readMidi(toMidi(result));
  const spec = toMidiSpec(result);

  assert.equal(parsed.format, 1);
  assert.equal(parsed.ppq, 480);
  // One tempo track plus one track per instrument.
  assert.equal(parsed.tracks.length, spec.tracks.length + 1);
  assert.equal(parsed.tempoBpm, result.bpm);
  assert.deepEqual(parsed.timeSignature, [4, 4]);

  const byName = new Map(parsed.tracks.map((t) => [t.name, t]));
  for (const track of spec.tracks) {
    const got = byName.get(track.name);
    assert.ok(got, `missing track "${track.name}"`);
    // The writer collapses same-key hits that land on the identical tick, so a
    // couple of humanised drum doubles may legitimately merge.
    assert.ok(
      got.notes.length <= track.notes.length && got.notes.length >= track.notes.length - 4,
      `${track.name}: note count ${got.notes.length} vs ${track.notes.length}`,
    );
    assert.equal(got.channel, track.channel, `${track.name}: wrong channel`);
    for (const note of got.notes) {
      assert.ok(note.midi >= 0 && note.midi <= 127);
      assert.ok(note.velocity >= 1 && note.velocity <= 127);
      assert.ok(note.durationTicks > 0, `${track.name}: zero-length note`);
    }
  }
  assert.equal(byName.get('Drums').channel, 9, 'drums must be on the GM percussion channel');
  assert.ok(byName.get('Pad').notes.length > 0);
  assert.ok(byName.get('Bass').notes.length > 0);
  assert.ok(byName.get('Drums').notes.length > 0);
});

test('every note-on is matched by a note-off', () => {
  const result = generate({ seed: 31, style: 'dnb', bars: 8, sampleRate: 22050 });
  const parsed = readMidi(toMidi(result));
  for (const track of parsed.tracks) {
    assert.equal(track.danglingNoteOns, 0, `${track.name} left ${track.danglingNoteOns} notes hanging`);
  }
});

/* =============================================================== session == */

test('the session JSON matches its schema', () => {
  for (const style of STYLE_NAMES) {
    const result = generate({ seed: 55, style, bars: 16, sampleRate: 22050 });
    const roundTripped = JSON.parse(JSON.stringify(result.session));
    assert.doesNotThrow(() => validateSession(roundTripped), `${style} session failed validation`);

    const s = roundTripped;
    assert.equal(s.schema, SESSION_SCHEMA_VERSION);
    assert.equal(s.seed, 55);
    assert.equal(s.style, style);
    assert.match(s.camelotKey, /^[A-G][#b]?m?$/);
    assert.equal(s.bars, 16);
    assert.equal(s.beatsPerBar, 4);
    assert.equal(s.downbeats.length, 16);
    assert.equal(s.energyCurve.length, 16);
    assert.ok(s.sections.length >= 3);
    assert.ok(s.chords.length >= 4);

    // Downbeats must be an evenly spaced grid at the reported tempo.
    const barSeconds = (60 / s.bpm) * 4;
    for (let i = 1; i < s.downbeats.length; i++) {
      assert.ok(Math.abs(s.downbeats[i] - s.downbeats[i - 1] - barSeconds) < 0.01);
    }
    // Sections must tile the whole track.
    let cursor = 0;
    for (const section of s.sections) {
      assert.equal(section.startBar, cursor);
      cursor += section.bars;
    }
    assert.equal(cursor, s.bars);
    // Audio duration must agree with the reported bar count.
    assert.ok(s.durationSec >= s.bars * barSeconds);
  }
});

test('validateSession rejects malformed input', () => {
  const good = generate({ seed: 1, style: 'lofi', ...FAST }).session;
  assert.throws(() => validateSession(null));
  assert.throws(() => validateSession({ ...good, schema: 99 }));
  assert.throws(() => validateSession({ ...good, camelot: '13A' }));
  assert.throws(() => validateSession({ ...good, energyCurve: [] }));
  assert.throws(() => validateSession({ ...good, chords: [] }));
  assert.throws(() => validateSession({ ...good, energyCurve: good.energyCurve.map(() => 2) }));
});

test('explicit bpm and key overrides are honoured', () => {
  const result = generate({ seed: 3, style: 'house', bars: 8, bpm: 128, key: 'F#m', sampleRate: 22050 });
  assert.equal(result.session.bpm, 128);
  assert.equal(result.session.key, 'F#m');
  assert.equal(result.session.camelot, '11A');
  assert.equal(result.session.scale, 'minor');
  for (const chord of result.session.chords) {
    assert.ok(chord.notes.every((n) => n >= 0 && n <= 11));
  }
});
