// AudioWorklet processor for the Realtime voice session.
//
// Captures mono mic audio, downsamples from the AudioContext sample rate
// (typically 48000 Hz) to 24000 Hz (OpenAI Realtime pcm16 native rate), and
// converts Float32 [-1, 1] samples to little-endian signed 16-bit PCM. The
// resulting ArrayBuffer is posted to the main thread, which base64-encodes it
// and sends it over the WebSocket as an `input_audio` frame.
//
// Served as a static asset from /pcm16-worklet.js (no bundler transforms).

const TARGET_RATE = 24000;

class PCM16DownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Fractional read position into the accumulated input buffer.
    this._readPos = 0;
    // Carryover input samples between process() calls for clean resampling.
    this._residual = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Append new samples to any residual from the previous block.
    const combined = new Float32Array(this._residual.length + channel.length);
    combined.set(this._residual, 0);
    combined.set(channel, this._residual.length);

    const ratio = sampleRate / TARGET_RATE;
    const outCount = Math.floor((combined.length - this._readPos) / ratio);
    if (outCount <= 0) {
      this._residual = combined;
      return true;
    }

    const pcm = new DataView(new ArrayBuffer(outCount * 2));
    let pos = this._readPos;
    for (let i = 0; i < outCount; i++) {
      const idx = Math.floor(pos);
      // Linear interpolation between adjacent input samples.
      const frac = pos - idx;
      const s0 = combined[idx] || 0;
      const s1 = combined[idx + 1] !== undefined ? combined[idx + 1] : s0;
      let sample = s0 + (s1 - s0) * frac;
      sample = Math.max(-1, Math.min(1, sample));
      pcm.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      pos += ratio;
    }

    // Keep the unconsumed tail (from floor(pos)) as residual for the next block.
    const consumed = Math.floor(pos);
    this._residual = combined.subarray(consumed);
    this._readPos = pos - consumed;

    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor('pcm16-downsampler', PCM16DownsamplerProcessor);
