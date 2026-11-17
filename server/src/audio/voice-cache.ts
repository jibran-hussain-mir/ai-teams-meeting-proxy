import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Synthesize = (
  text: string,
  onChunk: (pcm: Buffer) => void | Promise<void>,
  opts: { signal?: AbortSignal; previousText?: string },
) => Promise<unknown>;

/** About a tenth of a second of 24 kHz PCM16, the size speech normally arrives in. */
const CHUNK_BYTES = 4800;

/**
 * Wraps a voice so that chosen phrases are paid for once and replayed from
 * disk afterwards. Used for the handful of fixed "thinking" lines, which would
 * otherwise spend credits every time they are said.
 *
 * Resolves to `{ free: true }` when the audio came from disk.
 */
export function withVoiceCache(
  synthesize: Synthesize,
  dir: string,
  cacheable: (text: string) => boolean,
  /** Anything that changes the sound (the voice id): a different value means a different cache entry. */
  variant: () => string,
) {
  return async (
    text: string,
    onChunk: (pcm: Buffer) => void | Promise<void>,
    opts: { signal?: AbortSignal; previousText?: string } = {},
  ): Promise<{ free: boolean }> => {
    if (!cacheable(text)) {
      await synthesize(text, onChunk, opts);
      return { free: false };
    }
    const file = path.join(dir, `${createHash('sha1').update(`${variant()}\n${text}`).digest('hex')}.pcm`);

    if (existsSync(file)) {
      const pcm = readFileSync(file);
      for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
        if (opts.signal?.aborted) throw new Error('aborted');
        await onChunk(pcm.subarray(i, i + CHUNK_BYTES));
      }
      return { free: true };
    }

    // First use: play it as it arrives and keep a copy. Said on its own, without
    // the surrounding text, so the saved audio fits wherever it is reused.
    const parts: Buffer[] = [];
    await synthesize(
      text,
      async (pcm) => {
        parts.push(pcm);
        await onChunk(pcm);
      },
      { signal: opts.signal },
    );
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, Buffer.concat(parts));
    } catch {
      // Not being able to save only means paying again next time.
    }
    return { free: false };
  };
}
