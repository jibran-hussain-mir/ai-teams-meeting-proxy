import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withVoiceCache } from '../src/audio/voice-cache.js';

const dir = mkdtempSync(path.join(tmpdir(), 'ab-voice-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(voice = 'voice-1') {
  const paid: string[] = [];
  const audio = Buffer.alloc(10_000, 7);
  const speak = withVoiceCache(
    async (text, onChunk) => {
      paid.push(text);
      await onChunk(audio.subarray(0, 6000));
      await onChunk(audio.subarray(6000));
    },
    dir,
    (text) => text === 'Hmm, let me check.',
    () => voice,
  );
  const play = async (text: string) => {
    const chunks: Buffer[] = [];
    const result = await speak(text, (pcm) => void chunks.push(pcm));
    return { result, pcm: Buffer.concat(chunks) };
  };
  return { paid, audio, play };
}

describe('voice cache', () => {
  it('pays for a filler once and replays the same audio for free afterwards', async () => {
    const h = setup();
    const first = await h.play('Hmm, let me check.');
    expect(first.result.free).toBe(false);
    const second = await h.play('Hmm, let me check.');
    expect(second.result.free).toBe(true);
    expect(second.pcm.equals(h.audio)).toBe(true);
    expect(h.paid).toEqual(['Hmm, let me check.']);
  });

  it('never caches ordinary sentences', async () => {
    const h = setup();
    await h.play('The migration is done.');
    const again = await h.play('The migration is done.');
    expect(again.result.free).toBe(false);
    expect(h.paid).toEqual(['The migration is done.', 'The migration is done.']);
  });

  it('keeps separate audio for a different voice', async () => {
    const h = setup('voice-2');
    expect((await h.play('Hmm, let me check.')).result.free).toBe(false);
    expect((await h.play('Hmm, let me check.')).result.free).toBe(true);
  });
});
