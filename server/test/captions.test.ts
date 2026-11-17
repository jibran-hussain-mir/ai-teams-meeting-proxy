import { describe, expect, it } from 'vitest';
import { CaptionStt } from '../src/audio/captions.js';
import { RealtimeStt } from '../src/audio/stt.js';

function collect(stt: CaptionStt) {
  const finals: [string, string | undefined][] = [];
  stt.on('final', (text, speaker) => finals.push([text, speaker]));
  return finals;
}

describe('CaptionStt', () => {
  it('reports a line once it stops changing, with its speaker', () => {
    const stt = new CaptionStt('Bot');
    const finals = collect(stt);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'Sam do you want' }], 0);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'Sam do you want to go next' }], 500);
    stt.flush(1500);
    expect(finals).toEqual([]); // changed 1 s ago, no sentence end yet
    stt.flush(2100);
    expect(finals).toEqual([['Sam do you want to go next', 'Alex']]);
  });

  it('reports a finished sentence sooner', () => {
    const stt = new CaptionStt('Bot');
    const finals = collect(stt);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'Sam, do you want to go next?' }], 0);
    stt.flush(800);
    expect(finals).toEqual([['Sam, do you want to go next?', 'Alex']]);
  });

  it('reports only the new words when a bubble keeps growing', () => {
    const stt = new CaptionStt('Bot');
    const finals = collect(stt);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'First point.' }], 0);
    stt.flush(800);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'First point. Second point.' }], 1000);
    stt.flush(1800);
    expect(finals.map((f) => f[0])).toEqual(['First point.', 'Second point.']);
  });

  it('closes the previous bubble as soon as a new one appears', () => {
    const stt = new CaptionStt('Bot');
    const finals = collect(stt);
    stt.pushCaptions([{ id: 1, speaker: 'Alex', text: 'Over to you' }], 0);
    stt.pushCaptions(
      [
        { id: 1, speaker: 'Alex', text: 'Over to you' },
        { id: 2, speaker: 'Priya', text: 'Thanks' },
      ],
      200,
    );
    expect(finals).toEqual([['Over to you', 'Alex']]);
  });

  it("ignores the assistant's own speech and redrawn duplicates", () => {
    const stt = new CaptionStt('Bot');
    const finals = collect(stt);
    stt.pushCaptions([{ id: 1, speaker: 'Bot', text: 'The migration is done.' }], 0);
    stt.pushCaptions([{ id: 2, speaker: 'Alex', text: 'Thanks.' }], 100);
    stt.flush(1000);
    stt.pushCaptions([{ id: 3, speaker: 'Alex', text: 'Thanks.' }], 1100); // same line, new element
    stt.flush(2000);
    expect(finals).toEqual([['Thanks.', 'Alex']]);
  });
});

describe('RealtimeStt credit saving', () => {
  const frame = (amplitude: number) => {
    const buf = Buffer.alloc(1600 * 2); // 100 ms
    for (let i = 0; i < 1600; i++) buf.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 0x7fff), i * 2);
    return buf;
  };

  it('uploads nothing during silence', () => {
    const stt = new RealtimeStt(); // never connected: frames would queue as pending
    for (let t = 0; t < 50; t++) stt.send(frame(0), 10_000 + t * 100);
    expect((stt as unknown as { pending: Buffer[] }).pending).toHaveLength(0);
  });

  it('queues audio around speech, including a little from just before it', () => {
    const stt = new RealtimeStt();
    for (let t = 0; t < 10; t++) stt.send(frame(0), 10_000 + t * 100);
    stt.send(frame(0.3), 11_000);
    // 4 pre-roll frames + the speech frame
    expect((stt as unknown as { pending: Buffer[] }).pending).toHaveLength(5);
  });
});
