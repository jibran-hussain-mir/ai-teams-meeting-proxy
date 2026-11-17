/**
 * Energy-based speech detector over 16 kHz PCM16 frames. Used for barge-in
 * (someone talks while the agent is speaking) and for "is the room quiet".
 */
export class Vad {
  private speechMs = 0;
  private lastSpeechAt = 0;

  constructor(
    private readonly sampleRate = 16000,
    private readonly threshold = 0.02,
    /** Continuous speech needed before it counts, to ignore clicks and coughs. */
    private readonly minSpeechMs = 250,
  ) {}

  /** Feed a frame; returns true while sustained speech is present. */
  push(pcm: Buffer, now = Date.now()): boolean {
    const n = Math.floor(pcm.length / 2);
    if (n === 0) return this.speaking;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(i * 2) / 0x8000;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    const frameMs = (n / this.sampleRate) * 1000;
    if (rms >= this.threshold) {
      this.speechMs += frameMs;
      if (this.speaking) this.lastSpeechAt = now;
    } else {
      this.speechMs = 0;
    }
    return this.speaking;
  }

  get speaking(): boolean {
    return this.speechMs >= this.minSpeechMs;
  }

  /** Milliseconds since anyone last spoke (Infinity if nobody has yet). */
  silenceMs(now = Date.now()): number {
    if (this.speaking) return 0;
    return this.lastSpeechAt === 0 ? Infinity : now - this.lastSpeechAt;
  }

  /** Record speech that arrived as text rather than audio (rehearsals). */
  markSpeech(now = Date.now()): void {
    this.lastSpeechAt = now;
  }

  reset(): void {
    this.speechMs = 0;
  }
}
