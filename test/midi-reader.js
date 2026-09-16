/**
 * A ~90 line Standard MIDI File reader, written purely so the tests can prove
 * our writer produces something a sequencer would actually open. It handles
 * exactly what we emit: MThd, MTrk, meta events, program change, note on/off,
 * and running status (which we do not use, but a reader should tolerate).
 */

export function readMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const tag = () => {
    const s = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
    pos += 4;
    return s;
  };
  const u32 = () => { const v = view.getUint32(pos); pos += 4; return v; };
  const u16 = () => { const v = view.getUint16(pos); pos += 2; return v; };
  const u8 = () => view.getUint8(pos++);

  if (tag() !== 'MThd') throw new Error('not a MIDI file');
  const headerLength = u32();
  if (headerLength !== 6) throw new Error(`unexpected MThd length ${headerLength}`);
  const format = u16();
  const trackCount = u16();
  const ppq = u16();

  const result = { format, ppq, trackCount, tempoBpm: null, timeSignature: null, tracks: [] };

  for (let t = 0; t < trackCount; t++) {
    if (tag() !== 'MTrk') throw new Error(`track ${t} is not an MTrk`);
    const length = u32();
    const end = pos + length;

    const track = { name: '', channel: null, program: null, notes: [], danglingNoteOns: 0 };
    const open = new Map(); // `${channel}:${key}` -> { tick, velocity }
    let tick = 0;
    let runningStatus = 0;

    while (pos < end) {
      // Delta time (variable-length quantity).
      let delta = 0;
      for (;;) {
        const b = u8();
        delta = (delta << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      tick += delta;

      let status = u8();
      if ((status & 0x80) === 0) {
        pos--; // running status: reuse the previous status byte
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        const type = u8();
        let len = 0;
        for (;;) {
          const b = u8();
          len = (len << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        const data = new Uint8Array(bytes.buffer, bytes.byteOffset + pos, len);
        if (type === 0x03) track.name = new TextDecoder().decode(data);
        if (type === 0x51 && len === 3) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2];
          result.tempoBpm = Math.round(60000000 / us);
        }
        if (type === 0x58 && len >= 2) result.timeSignature = [data[0], 2 ** data[1]];
        pos += len;
        if (type === 0x2f) break; // end of track
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        let len = 0;
        for (;;) {
          const b = u8();
          len = (len << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        pos += len;
        continue;
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (track.channel === null) track.channel = channel;

      if (kind === 0x90 || kind === 0x80) {
        const key = u8();
        const velocity = u8();
        const id = `${channel}:${key}`;
        if (kind === 0x90 && velocity > 0) {
          open.set(id, { tick, velocity });
        } else {
          const started = open.get(id);
          if (started) {
            open.delete(id);
            track.notes.push({
              midi: key,
              velocity: started.velocity,
              startTick: started.tick,
              durationTicks: tick - started.tick,
            });
          }
        }
      } else if (kind === 0xc0) {
        track.program = u8();
      } else if (kind === 0xd0) {
        u8();
      } else {
        u8();
        u8();
      }
    }

    track.danglingNoteOns = open.size;
    pos = end;
    if (track.notes.length > 0 || track.name) result.tracks.push(track);
  }

  return result;
}
