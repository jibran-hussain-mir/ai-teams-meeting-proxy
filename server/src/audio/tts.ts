import { config } from '../config.js';

/** The audio format asked for and played back: 24 kHz PCM16 mono. */
export const TTS_SAMPLE_RATE = 24000;

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.detail?.message ?? parsed?.detail ?? detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {}
  return new Error(`${what} failed (${res.status}): ${detail}`);
}

/**
 * Speak `text` in the cloned voice. PCM16 mono 24 kHz chunks are passed to
 * `onChunk` as they arrive, so playback can start before synthesis finishes.
 */
export async function synthesize(
  text: string,
  onChunk: (pcm: Buffer) => void | Promise<void>,
  opts: { signal?: AbortSignal; previousText?: string; voiceId?: string } = {},
): Promise<void> {
  const voiceId = opts.voiceId ?? config.elevenLabsVoiceId;
  const res = await fetch(`${config.elevenLabsApiUrl}/text-to-speech/${voiceId}/stream?output_format=pcm_${TTS_SAMPLE_RATE}`, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: config.ttsModel,
      previous_text: opts.previousText || undefined,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw await failure(res, 'Text-to-speech');

  // Chunks can split a 16-bit sample in half; carry the odd byte over.
  let carry: Buffer = Buffer.alloc(0);
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    let buf: Buffer = Buffer.concat([carry, Buffer.from(part)]);
    if (buf.length % 2 === 1) {
      carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    } else {
      carry = Buffer.alloc(0);
    }
    if (buf.length) await onChunk(buf);
  }
}

/** Create an instant voice clone from recorded samples; returns the voice id. */
export async function createVoiceClone(
  name: string,
  samples: { filename: string; data: Buffer; mimeType: string }[],
): Promise<string> {
  const form = new FormData();
  form.append('name', name);
  form.append('remove_background_noise', 'true');
  for (const s of samples) {
    form.append('files', new Blob([new Uint8Array(s.data)], { type: s.mimeType }), s.filename);
  }
  const res = await fetch(`${config.elevenLabsApiUrl}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey },
    body: form,
  });
  if (!res.ok) throw await failure(res, 'Voice clone');
  const json = (await res.json()) as { voice_id: string };
  return json.voice_id;
}

/** Wrap raw PCM16 mono in a WAV header so a browser can play it. */
export function pcmToWav(pcm: Buffer, sampleRate = TTS_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
