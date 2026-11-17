import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Locator, Page, Route } from 'playwright';
import { config, DATA_DIR } from '../config.js';
import { launchAudioPage, type AudioPage } from './browser.js';
import type { BrowserUsage } from './resources.js';
import type { CaptionItem } from '../audio/captions.js';
import { CAPTIONS_JS, DENIED_TEXT, ENDED_TEXT, LOBBY_TEXT, PARTICIPANTS_JS, SEL } from './selectors.js';

export class JoinError extends Error {}

/** Pages on Teams' own sites (teams.microsoft.com, teams.live.com, teams.microsoft.us and their subdomains). */
const TEAMS_PAGES = /^https:\/\/([a-z0-9-]+\.)?teams\.(microsoft|live)\.(com|us)\//;

/**
 * Teams' join page tries to open the Teams desktop app first (it navigates to
 * an `ms-teams:` link), which makes the browser ask "Open Microsoft Teams?".
 * The assistant's browser starts with a fresh profile every meeting, so an
 * "Always allow" answer is never remembered, and allowing it would open the
 * owner's own Teams app anyway. Asking the join page not to try the app
 * (`msLaunch=false`) removes the question entirely.
 *
 * Returns the launcher address with that change, or null if `url` is not the
 * launcher or already has it.
 */
export function withoutAppLaunch(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/\/dl\/launcher\/launcher\.html$/.test(u.pathname) || u.searchParams.get('msLaunch') === 'false') return null;
  u.searchParams.set('msLaunch', 'false');
  u.searchParams.set('suppressPrompt', 'true');
  return u.toString();
}

/**
 * Page navigations on Teams' sites go through here while joining. The pasted
 * link is redirected by Teams' servers to the launcher, so the redirect is
 * followed one step at a time and changed when it points at the launcher.
 */
async function skipAppLaunch(route: Route): Promise<void> {
  const req = route.request();
  if (!req.isNavigationRequest() || req.frame() !== req.frame().page().mainFrame()) return route.continue();
  const direct = withoutAppLaunch(req.url());
  if (direct) return route.fulfill({ status: 302, headers: { location: direct } });
  try {
    const res = await route.fetch({ maxRedirects: 0 });
    const location = res.headers()['location'];
    const fixed = location ? withoutAppLaunch(new URL(location, req.url()).toString()) : null;
    if (fixed) return route.fulfill({ status: res.status(), headers: { location: fixed } });
    return route.fulfill({ response: res });
  } catch {
    // Could not look ahead: let the browser load it normally (worst case, the old question appears).
    return route.continue().catch(() => {});
  }
}

export interface TeamsBotEvents {
  /** The newest few live captions, oldest first (best effort). */
  captions: [items: CaptionItem[]];
  /** We are no longer in the meeting. */
  ended: [reason: string];
  /** People in the meeting including us; 0 when Teams shows no number. Sent on every poll once known. */
  participants: [count: number];
}

export interface JoinOptions {
  link: string;
  displayName: string;
  /** How long to wait in the lobby before giving up. */
  lobbyTimeoutMs?: number;
  onLobby?: () => void;
}

/** Joins a Teams meeting as a guest through the web client and drives its UI. */
export class TeamsBot extends EventEmitter<TeamsBotEvents> {
  private poll: NodeJS.Timeout | null = null;
  private left = false;
  private missingHangupSince = 0;
  private lastCount = -1;

  private constructor(private readonly audio: AudioPage) {
    super();
  }

  static async launch(opts: { headless: boolean; onAudio: (pcm: Buffer) => void; slot?: number }): Promise<TeamsBot> {
    return new TeamsBot(await launchAudioPage(opts));
  }

  private get page(): Page {
    return this.audio.page;
  }

  play(pcm: Buffer, sampleRate: number): Promise<number> {
    return this.audio.play(pcm, sampleRate);
  }
  stopSpeaking(): Promise<void> {
    return this.audio.stopSpeaking().catch(() => {});
  }
  queuedSeconds(): Promise<number> {
    return this.audio.queuedSeconds().catch(() => 0);
  }
  resourceUsage(): Promise<BrowserUsage> {
    return this.audio.usage();
  }

  /** First visible element among the candidate selectors, or null. */
  private async find(candidates: readonly string[], timeoutMs = 0): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const sel of candidates) {
        const loc = this.page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      }
      if (Date.now() >= deadline) return null;
      await this.page.waitForTimeout(250);
    }
  }

  private async bodyMatches(patterns: RegExp[]): Promise<boolean> {
    const text = await this.page
      .locator('body')
      .innerText({ timeout: 2000 })
      .catch(() => '');
    return patterns.some((p) => p.test(text));
  }

  private async fail(message: string): Promise<never> {
    const shot = path.join(DATA_DIR, `join-failure-${Date.now()}.png`);
    await this.page.screenshot({ path: shot }).catch(() => {});
    throw new JoinError(`${message} (screenshot: ${shot})`);
  }

  async join(opts: JoinOptions): Promise<void> {
    const page = this.page;
    // Only needed until the web client is reached: routing every request of a
    // running meeting through here would cost CPU for nothing.
    await page.route(TEAMS_PAGES, (route) => skipAppLaunch(route));
    try {
      await page.goto(opts.link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch {
      await page.unroute(TEAMS_PAGES).catch(() => {});
      await this.fail('Could not open the meeting link');
    }

    // Launcher page → web client. Either the launcher button or the pre-join
    // name box shows up first, depending on the link type.
    const deadline = Date.now() + 90_000;
    let nameInput: Locator | null = null;
    while (!nameInput && Date.now() < deadline) {
      nameInput = await this.find(SEL.nameInput);
      if (nameInput) break;
      const cont = await this.find(SEL.continueInBrowser);
      if (cont) {
        // Past the launcher: stop intercepting before the much heavier web client loads.
        await page.unroute(TEAMS_PAGES).catch(() => {});
        await cont.click().catch(() => {});
      }
      if (await this.bodyMatches(DENIED_TEXT)) {
        await this.fail('Teams would not let a guest into this meeting');
      }
      await page.waitForTimeout(500);
    }
    await page.unroute(TEAMS_PAGES).catch(() => {});
    if (!nameInput) {
      await this.fail(
        'Never reached the Teams join screen. The organiser may block guests, or the Teams page layout has changed',
      );
    }

    await nameInput!.fill(opts.displayName);

    // Camera off, microphone on. The mic only ever carries synthesized speech.
    const cam = await this.find(SEL.prejoinCameraToggle);
    if (cam && (await this.isOn(cam))) await cam.click().catch(() => {});
    const mic = await this.find(SEL.prejoinMicToggle);
    if (mic && !(await this.isOn(mic))) await mic.click().catch(() => {});

    const joinBtn = await this.find(SEL.joinNow, 10_000);
    if (!joinBtn) await this.fail('Could not find the "Join now" button');
    await joinBtn!.click();

    // Lobby or straight in.
    const lobbyDeadline = Date.now() + (opts.lobbyTimeoutMs ?? config.lobbyTimeoutMs);
    let toldLobby = false;
    for (;;) {
      if (await this.find(SEL.hangup)) break;
      if (await this.bodyMatches(DENIED_TEXT)) await this.fail('The request to join was denied or timed out');
      if (!toldLobby && (await this.bodyMatches(LOBBY_TEXT))) {
        toldLobby = true;
        opts.onLobby?.();
      }
      if (Date.now() > lobbyDeadline) await this.fail('Nobody admitted the assistant from the lobby');
      await page.waitForTimeout(1000);
    }

    await this.enableCaptions().catch(() => {});
    this.startPolling();
  }

  private async isOn(toggle: Locator): Promise<boolean> {
    const checked = await toggle.getAttribute('aria-checked').catch(() => null);
    if (checked !== null) return checked === 'true';
    return toggle.isChecked().catch(() => false);
  }

  /** Captions give us speaker names. Failing to enable them is not fatal. */
  private async enableCaptions(): Promise<void> {
    const more = await this.find(SEL.moreButton, 5000);
    if (!more) return;
    await more.click();
    let toggle = await this.find(SEL.captionsToggle, 1500);
    if (!toggle) {
      const nested = await this.find(SEL.languageAndSpeech, 1500);
      if (nested) {
        await nested.click();
        toggle = await this.find(SEL.captionsToggle, 2500);
      }
    }
    if (toggle) await toggle.click().catch(() => {});
    else await this.page.keyboard.press('Escape').catch(() => {});
  }

  private startPolling(): void {
    this.poll = setInterval(async () => {
      if (this.left) return;
      try {
        const items = (await this.page.evaluate(CAPTIONS_JS)) as CaptionItem[];
        if (items.length) this.emit('captions', items);
        const count = (await this.page.evaluate(PARTICIPANTS_JS)) as number | null;
        if (count !== null) {
          if (count !== this.lastCount) {
            console.log(`[teams] people in the meeting: ${count === 0 ? 'no number shown' : count}`);
            this.lastCount = count;
          }
          this.emit('participants', count);
        }
        // Out of the meeting once the hang-up button has been gone for 5 s.
        if (await this.find(SEL.hangup)) {
          this.missingHangupSince = 0;
        } else {
          this.missingHangupSince ||= Date.now();
          if (Date.now() - this.missingHangupSince > 5000) {
            const removed = await this.bodyMatches(ENDED_TEXT);
            this.finish(removed ? 'The meeting ended or the assistant was removed' : 'Lost the meeting window');
          }
        }
      } catch {
        if (this.page.isClosed()) this.finish('The browser window was closed');
      }
    }, 700);
  }

  private finish(reason: string): void {
    if (this.left) return;
    this.left = true;
    if (this.poll) clearInterval(this.poll);
    this.emit('ended', reason);
  }

  /** Make sure Teams itself has not muted us (organisers can mute guests). */
  async setMuted(muted: boolean): Promise<void> {
    const btn = await this.find(SEL.micButton);
    if (!btn) return;
    const label = ((await btn.getAttribute('aria-label').catch(() => '')) ?? '').toLowerCase();
    const isMuted = label.includes('unmute');
    if (isMuted !== muted) await btn.click().catch(() => {});
  }

  async raiseHand(raised: boolean): Promise<void> {
    const btn = await this.find(SEL.raiseHand);
    if (!btn) return;
    const label = ((await btn.getAttribute('aria-label').catch(() => '')) ?? '').toLowerCase();
    const pressed = (await btn.getAttribute('aria-pressed').catch(() => null)) === 'true';
    const isRaised = pressed || label.includes('lower');
    if (isRaised !== raised) await btn.click().catch(() => {});
  }

  /** Post in the meeting chat. Returns false if guests cannot chat here. */
  async sendChat(text: string): Promise<boolean> {
    try {
      let input = await this.find(SEL.chatInput);
      if (!input) {
        const chat = await this.find(SEL.chatButton);
        if (!chat) return false;
        await chat.click();
        input = await this.find(SEL.chatInput, 5000);
      }
      if (!input) return false;
      await input.click();
      await this.page.keyboard.insertText(text);
      const send = await this.find(SEL.chatSend, 1000);
      if (send) await send.click();
      else await this.page.keyboard.press('Enter');
      return true;
    } catch {
      return false;
    }
  }

  async leave(): Promise<void> {
    const wasIn = !this.left;
    this.left = true;
    if (this.poll) clearInterval(this.poll);
    if (wasIn) {
      const hangup = await this.find(SEL.hangup).catch(() => null);
      if (hangup) {
        await hangup.click().catch(() => {});
        await this.page.waitForTimeout(1000).catch(() => {});
      }
    }
    await this.audio.close();
  }
}
