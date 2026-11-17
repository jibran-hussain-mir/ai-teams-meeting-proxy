import type { Llm } from './llm.js';
import { turnPrompt, type TurnInput } from './prompts.js';

export type Decision =
  | { action: 'silent' }
  | { action: 'speak'; say: string; deliversUpdate: boolean }
  | { action: 'escalate'; say: string; asker: string; question: string; deliversUpdate: boolean }
  /** Asked to go: say goodbye (if anything) and leave the meeting. */
  | { action: 'leave'; say: string; deliversUpdate: boolean };

function field(text: string, name: string): string {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

function sayBody(text: string): string | null {
  const m = /^SAY:[ \t]*/m.exec(text);
  return m ? text.slice(m.index + m[0].length) : null;
}

/** Parse the model's reply. Anything malformed is treated as staying silent. */
export function parseDecision(text: string): Decision {
  const action = field(text, 'ACTION').toLowerCase();
  const say = (sayBody(text) ?? '').trim();
  const deliversUpdate = field(text, 'DELIVERS_UPDATE').toLowerCase().startsWith('y');
  if (action.startsWith('speak') && say) return { action: 'speak', say, deliversUpdate };
  if (action.startsWith('leave')) return { action: 'leave', say, deliversUpdate };
  if (action.startsWith('escalate')) {
    const question = field(text, 'QUESTION');
    if (question) {
      return { action: 'escalate', say, asker: field(text, 'ASKER') || 'Someone', question, deliversUpdate };
    }
    // Wanted to escalate but gave no question: speaking is still better than silence.
    if (say) return { action: 'speak', say, deliversUpdate };
  }
  return { action: 'silent' };
}

/**
 * Splits streamed text into sentences as soon as each one is complete, so
 * speech synthesis can start before the model has finished writing.
 */
export class SentenceStream {
  private buf = '';
  private held = '';
  constructor(private readonly onSentence: (sentence: string) => void) {}

  push(delta: string): void {
    this.buf += delta;
    for (;;) {
      // A sentence ends at . ! or ? followed by whitespace (not inside "3.5").
      const m = /[.!?]["')\]]?\s+/.exec(this.buf);
      if (!m) return;
      const end = m.index + m[0].length;
      const sentence = (this.held + this.buf.slice(0, end)).trim();
      this.buf = this.buf.slice(end);
      // Very short fragments ("Yes.") sound choppy alone: glue them to the next.
      if (sentence.length < 12) {
        this.held = sentence + ' ';
        continue;
      }
      this.held = '';
      this.onSentence(sentence);
    }
  }

  end(): void {
    const rest = (this.held + this.buf).trim();
    this.held = '';
    this.buf = '';
    if (rest) this.onSentence(rest);
  }
}

/**
 * Run one turn of the brain. `onSentence` fires for each sentence of the
 * spoken reply while the model is still writing. `onAction` fires once, as
 * soon as the model has written whether it will stay silent, speak or escalate.
 */
export async function runTurn(
  llm: Llm,
  input: TurnInput,
  onSentence?: (sentence: string) => void,
  onAction?: (action: Decision['action']) => void,
): Promise<Decision> {
  let raw = '';
  let spokenFrom = -1; // index in `raw` where the SAY body starts
  let actionKnown = false;
  const sentences = new SentenceStream((s) => onSentence?.(s));

  const full = await llm.ask(turnPrompt(input), (delta) => {
    raw += delta;
    if (!actionKnown && onAction) {
      // The ACTION line is complete once its line break has arrived.
      const m = /^ACTION:[ \t]*(\w+)[^\n]*\n/m.exec(raw);
      if (m) {
        actionKnown = true;
        const a = m[1].toLowerCase();
        onAction(
          a.startsWith('speak') ? 'speak' : a.startsWith('escalate') ? 'escalate' : a.startsWith('leave') ? 'leave' : 'silent',
        );
      }
    }
    if (!onSentence) return;
    if (spokenFrom < 0) {
      const m = /^SAY:[ \t]*/m.exec(raw);
      if (!m) return;
      spokenFrom = m.index + m[0].length;
      sentences.push(raw.slice(spokenFrom));
    } else {
      sentences.push(delta);
    }
  });

  const decision = parseDecision(full || raw);
  if (onSentence) {
    if (spokenFrom >= 0) sentences.end();
    else if (decision.action !== 'silent' && decision.say) onSentence(decision.say); // reply was not streamed
  }
  return decision;
}
