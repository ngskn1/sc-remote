// Test-only audio source (SCREENSHARE_FAKE_AUDIO=1): a 440 Hz tone in the same PCM format
// the native capture produces (s16le, stereo, 48 kHz, 10 ms chunks). Exercises the full app pipeline.
let timer = null;
module.exports = {
  list: async () => [{ id: 'tone', label: 'Test tone (440 Hz)', recommended: true }],
  start: async (_id, onChunk) => {
    let t = 0;
    timer = setInterval(() => {
      const frames = 480, buf = Buffer.alloc(frames * 4);
      for (let i = 0; i < frames; i++, t++) {
        const v = Math.round(Math.sin(2 * Math.PI * 440 * t / 48000) * 12000);
        buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2);
      }
      onChunk(buf);
    }, 10);
    return { type: 'pcm', note: '' };
  },
  stop: () => { clearInterval(timer); timer = null; },
  stopSync: () => { clearInterval(timer); timer = null; },
};
