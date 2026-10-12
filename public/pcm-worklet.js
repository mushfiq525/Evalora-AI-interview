// Runs on the audio thread. Takes microphone audio at the browser's sample rate,
// downsamples to 16 kHz mono and posts 16-bit PCM chunks (~40 ms) to the page.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.out = [];
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.sum / this.count));
        this.out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        this.sum = 0;
        this.count = 0;
      }
    }
    if (this.out.length >= 640) {
      const pcm = Int16Array.from(this.out);
      this.out = [];
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
