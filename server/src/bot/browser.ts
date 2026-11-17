import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BrowserMeter, type BrowserUsage } from './resources.js';

const INJECT_SCRIPT = readFileSync(
  fileURLToPath(new URL('./inject.page.js', import.meta.url)),
  'utf8',
);

export const CAPTURE_SAMPLE_RATE = 16000;

export interface AudioPage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Queue PCM16 mono audio to be spoken. Resolves to seconds still queued. */
  play(pcm: Buffer, sampleRate: number): Promise<number>;
  /** Cut speech off immediately. */
  stopSpeaking(): Promise<void>;
  /** Seconds of speech still queued in the page. */
  queuedSeconds(): Promise<number>;
  /** Memory and CPU this browser is using, all its processes together. */
  usage(): Promise<BrowserUsage>;
  close(): Promise<void>;
}

export interface AudioPageOptions {
  headless: boolean;
  /** Called with 16 kHz mono PCM16 frames of everything the bot hears. */
  onAudio: (pcm: Buffer) => void;
  /** Which of the simultaneous meetings this is (0, 1, 2…), so windows do not stack exactly. */
  slot?: number;
}

/**
 * Launches Chromium with the audio bridge installed: the page's microphone is
 * fed by `play()` and all remote WebRTC audio is delivered to `onAudio`.
 */
export async function launchAudioPage(opts: AudioPageOptions): Promise<AudioPage> {
  const offset = 40 + (opts.slot ?? 0) * 60;
  const browser = await chromium.launch({
    headless: opts.headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      // Do not use the computer's sound output at all. Everything the assistant
      // says and hears travels inside the page, and the page's audio clock must
      // not depend on a real device: with some outputs (Bluetooth earbuds, for
      // one) that clock stalls, and the assistant then neither hears nor speaks.
      // This also keeps the meetings from playing through the speakers.
      '--disable-audio-output',
      `--window-position=${offset},${offset}`,
    ],
  });
  const context = await browser.newContext({
    bypassCSP: true,
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 800 },
  });
  await context.exposeFunction('__abAudioIn', (b64: string) => {
    opts.onAudio(Buffer.from(b64, 'base64'));
  });
  await context.addInitScript({ content: INJECT_SCRIPT });
  const page = await context.newPage();

  const meter = new BrowserMeter(() => browser.newBrowserCDPSession());

  return {
    browser,
    context,
    page,
    play: (pcm, sampleRate) =>
      page.evaluate(
        ([b64, rate]) => (window as any).__abPlay(b64, rate) as number,
        [pcm.toString('base64'), sampleRate] as const,
      ),
    stopSpeaking: () => page.evaluate(() => (window as any).__abStop()),
    queuedSeconds: () => page.evaluate(() => (window as any).__abQueued() as number),
    usage: () => meter.sample(),
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
