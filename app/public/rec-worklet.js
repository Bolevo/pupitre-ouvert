// « Enregistrer ma voix »: the microphone's samples, in batches of 2048 frames, each with the
// context frame of its first sample (the main thread places them on the score; src/audio/take.ts).
// Silence is sent while the input has no data yet, so that the frames stay continuous (`live`
// tells whether the batch held real input). Its output is silent: the microphone is never heard.
class PupitreRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.frame = 0;
    this.on = true;
    this.live = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.send();
        this.on = false;
        this.port.postMessage('done');
      }
    };
  }
  send() {
    if (!this.n) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ frame: this.frame, data, live: this.live }, [data.buffer]);
    this.n = 0;
    this.live = false;
  }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n + len > this.buf.length) this.send();
    if (this.n === 0) this.frame = currentFrame;
    if (ch) {
      this.buf.set(ch, this.n);
      this.live = true;
    } else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    if (this.n >= this.buf.length) this.send();
    return true;
  }
}
registerProcessor('pupitre-rec', PupitreRec);
