import { EventEmitter } from 'node:events';

export interface CaptionItem {
  /** Stable id for one caption bubble in the Teams page. */
  id: number;
  speaker: string;
  text: string;
}

export interface TranscriberEvents {
  partial: [text: string];
  final: [text: string, speaker?: string];
  fatal: [message: string];
  /** The paid transcription budget for this meeting is used up. */
  limit: [];
}

interface Bubble {
  speaker: string;
  text: string;
  /** How much of `text` has already been reported as final. */
  emitted: number;
  changedAt: number;
}

/**
 * Free transcription: reads Teams' own live captions instead of paying for
 * speech-to-text. Teams keeps appending to a caption bubble while someone
 * talks, so a line counts as finished once it stops changing (sooner if it
 * ends a sentence) or once a newer bubble appears.
 */
export class CaptionStt extends EventEmitter<TranscriberEvents> {
  readonly usesCaptions = true;
  /** Nothing is sent to a paid service. */
  readonly secondsSent = 0;
  private readonly bubbles = new Map<number, Bubble>();
  private lastId = 0;
  private lastPartial = '';
  private recent: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    /** Captions of the assistant's own speech are skipped. */
    private readonly ignoreSpeaker: string,
    private readonly stableMs = 1500,
    private readonly sentenceStableMs = 700,
  ) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => this.flush(Date.now()), 300);
  }

  send(): void {}

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pushCaptions(items: CaptionItem[], now = Date.now()): void {
    for (const item of items) {
      this.lastId = Math.max(this.lastId, item.id);
      if (item.speaker === this.ignoreSpeaker) continue;
      let b = this.bubbles.get(item.id);
      if (!b) {
        b = { speaker: item.speaker, text: '', emitted: 0, changedAt: now };
        this.bubbles.set(item.id, b);
      }
      if (item.text !== b.text) {
        b.text = item.text;
        b.speaker = item.speaker || b.speaker;
        b.changedAt = now;
        b.emitted = Math.min(b.emitted, b.text.length); // Teams revised earlier words
      }
    }
    this.flush(now);
  }

  flush(now: number): void {
    for (const [id, b] of this.bubbles) {
      const rest = b.text.slice(b.emitted).trim();
      const newest = id === this.lastId;
      const quietFor = now - b.changedAt;
      const done =
        !newest || quietFor >= this.stableMs || (quietFor >= this.sentenceStableMs && /[.?!]["')]?$/.test(rest));
      if (rest && done) {
        b.emitted = b.text.length;
        this.lastPartial = '';
        // Teams sometimes redraws a bubble, which would repeat the line.
        const key = `${b.speaker}|${rest}`;
        if (!this.recent.includes(key)) {
          this.recent.push(key);
          if (this.recent.length > 6) this.recent.shift();
          this.emit('final', rest, b.speaker || undefined);
        }
      } else if (rest && newest && rest !== this.lastPartial) {
        this.lastPartial = rest;
        this.emit('partial', rest);
      }
      if (!newest && quietFor > 60_000) this.bubbles.delete(id);
    }
  }
}
