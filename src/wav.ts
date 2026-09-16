/**
 * Hand-written RIFF/WAVE encoder. 16-bit signed PCM, interleaved stereo.
 * No dependency, and the header is small enough to read in one sitting:
 *
 *   "RIFF" <size-8> "WAVE"
 *   "fmt " 16 | PCM(1) | channels | rate | byteRate | blockAlign | bits
 *   "data" <bytes> | samples...
 */

import type { StereoBuffer } from './synth.js';

export const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Round-to-nearest with a symmetric clamp so nothing wraps to full-scale negative. */
function toPcm16(sample: number): number {
  const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
  const scaled = Math.round(clamped * 32767);
  return scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
}

export function encodeWav(buffer: StereoBuffer): Uint8Array {
  const frames = buffer.left.length;
  const channels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, toPcm16(buffer.left[i]!), true);
    view.setInt16(offset + 2, toPcm16(buffer.right[i]!), true);
    offset += 4;
  }

  return bytes;
}

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataBytes: number;
  frames: number;
  riffSize: number;
}

/** Minimal reader used by the test-suite to verify our own header. */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  if (tag(12) !== 'fmt ') throw new Error('Missing fmt chunk');
  if (tag(36) !== 'data') throw new Error('Missing data chunk');
  const blockAlign = view.getUint16(32, true);
  const dataBytes = view.getUint32(40, true);
  return {
    riffSize: view.getUint32(4, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign,
    bitsPerSample: view.getUint16(34, true),
    dataBytes,
    frames: blockAlign > 0 ? dataBytes / blockAlign : 0,
  };
}
