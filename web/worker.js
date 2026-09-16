/**
 * Generation worker. Keeps the ~1-4 second render off the main thread so the
 * page keeps animating at 60fps while a track is being synthesised.
 *
 * It imports the compiled engine directly as an ES module -- no bundler.
 */

import { generate, toWav, toMidi } from '../dist/index.js';

self.onmessage = (event) => {
  const { id, options } = event.data;
  try {
    const result = generate({
      ...options,
      onProgress: (fraction, label) => {
        self.postMessage({ id, type: 'progress', fraction, label });
      },
    });

    const wav = toWav(result);
    const midi = toMidi(result);
    const left = result.audio.left;
    const right = result.audio.right;

    self.postMessage(
      {
        id,
        type: 'done',
        session: result.session,
        sampleRate: result.audio.sampleRate,
        left,
        right,
        wav,
        midi,
      },
      // Transfer instead of copy: ~35 MB of audio moves in constant time.
      [left.buffer, right.buffer, wav.buffer, midi.buffer],
    );
  } catch (error) {
    self.postMessage({ id, type: 'error', message: String((error && error.message) || error) });
  }
};
