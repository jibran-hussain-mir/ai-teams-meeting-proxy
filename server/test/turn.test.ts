import { describe, expect, it } from 'vitest';
import { Vad } from '../src/audio/vad.js';
import type { Llm } from '../src/brain/llm.js';
import { parseDecision, runTurn, SentenceStream } from '../src/brain/turn.js';

describe('runTurn decision callback', () => {
  it('reports the action as soon as that line is complete, before the words', async () => {
    const seen: string[] = [];
    const llm: Llm = {
      async ask(_prompt, onText) {
        onText?.('ACTION: sp');
        seen.push('partial');
        onText?.('eak\nDELIVERS_UPDATE: no\n');
        onText?.('SAY: Hello there everyone.');
        return 'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: Hello there everyone.';
      },
      close() {},
    };
    await runTurn(
      llm,
      { updateDelivered: true, pendingQuestions: [], lines: [] },
      (s) => seen.push(`sentence:${s}`),
      (a) => seen.push(`action:${a}`),
    );
    expect(seen).toEqual(['partial', 'action:speak', 'sentence:Hello there everyone.']);
  });
});

describe('parseDecision for leaving', () => {
  it('reads a request to leave, with or without a goodbye', () => {
    expect(parseDecision('ACTION: leave\nDELIVERS_UPDATE: no\nSAY: Thanks everyone, goodbye.')).toEqual({
      action: 'leave',
      say: 'Thanks everyone, goodbye.',
      deliversUpdate: false,
    });
    expect(parseDecision('ACTION: leave\nDELIVERS_UPDATE: no')).toEqual({ action: 'leave', say: '', deliversUpdate: false });
  });
});

describe('parseDecision', () => {
  it('reads a silent decision', () => {
    expect(parseDecision('ACTION: silent\nDELIVERS_UPDATE: no')).toEqual({ action: 'silent' });
  });

  it('reads a spoken reply, including later lines of SAY', () => {
    const d = parseDecision('ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.\nError rate is 0.2%.');
    expect(d).toEqual({ action: 'speak', deliversUpdate: true, say: 'The migration is done.\nError rate is 0.2%.' });
  });

  it('reads an escalation', () => {
    const d = parseDecision(
      'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Alex\nQUESTION: Can you commit to Friday?\nSAY: I have asked Sam.',
    );
    expect(d).toEqual({
      action: 'escalate',
      deliversUpdate: false,
      asker: 'Alex',
      question: 'Can you commit to Friday?',
      say: 'I have asked Sam.',
    });
  });

  it('stays silent on anything malformed', () => {
    expect(parseDecision('Sure, I think I should say hello!')).toEqual({ action: 'silent' });
    expect(parseDecision('ACTION: speak')).toEqual({ action: 'silent' });
    expect(parseDecision('')).toEqual({ action: 'silent' });
  });

  it('speaks rather than dropping an escalation that has no question', () => {
    expect(parseDecision('ACTION: escalate\nSAY: Let me check.')).toMatchObject({ action: 'speak', say: 'Let me check.' });
  });
});

describe('SentenceStream', () => {
  const collect = (deltas: string[]) => {
    const out: string[] = [];
    const s = new SentenceStream((x) => out.push(x));
    deltas.forEach((d) => s.push(d));
    s.end();
    return out;
  };

  it('emits each sentence as soon as it is complete', () => {
    expect(collect(['The migration is do', 'ne. Error rate is ', 'down. Next up'])).toEqual([
      'The migration is done.',
      'Error rate is down.',
      'Next up',
    ]);
  });

  it('does not split decimals', () => {
    expect(collect(['Error rate fell to 0.2% this week. Good news.'])).toEqual([
      'Error rate fell to 0.2% this week.',
      'Good news.',
    ]);
  });

  it('joins a very short opener to what follows', () => {
    expect(collect(['Yes. ', 'It ships on the 28th.'])).toEqual(['Yes. It ships on the 28th.']);
  });
});

describe('runTurn', () => {
  const fakeLlm = (chunks: string[]): Llm => ({
    async ask(_prompt, onText) {
      for (const c of chunks) onText?.(c);
      return chunks.join('');
    },
    close() {},
  });
  const input = { updateDelivered: false, pendingQuestions: [], lines: [{ speaker: 'Alex', text: 'Sam, your update?' }] };

  it('streams only the SAY text to the voice, never the header', async () => {
    const spoken: string[] = [];
    const d = await runTurn(
      fakeLlm(['ACTION: sp', 'eak\nDELIVERS_UPDATE: yes\nSA', 'Y: The migration ', 'is done. It went well.']),
      input,
      (s) => spoken.push(s),
    );
    expect(d.action).toBe('speak');
    expect(spoken).toEqual(['The migration is done.', 'It went well.']);
  });

  it('says nothing when the decision is silent', async () => {
    const spoken: string[] = [];
    const d = await runTurn(fakeLlm(['ACTION: silent\nDELIVERS_UPDATE: no']), input, (s) => spoken.push(s));
    expect(d.action).toBe('silent');
    expect(spoken).toEqual([]);
  });
});

describe('Vad', () => {
  const frame = (amplitude: number, ms = 100) => {
    const n = (16000 * ms) / 1000;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 0x7fff), i * 2);
    return buf;
  };

  it('needs sustained speech, then reports silence duration', () => {
    const vad = new Vad(16000, 0.02, 300);
    expect(vad.silenceMs(0)).toBe(Infinity);
    expect(vad.push(frame(0.3), 1000)).toBe(false); // 100 ms: could be a click
    vad.push(frame(0.3), 1100);
    expect(vad.push(frame(0.3), 1200)).toBe(true);
    expect(vad.push(frame(0), 1300)).toBe(false);
    expect(vad.silenceMs(2200)).toBe(1000);
  });
});
