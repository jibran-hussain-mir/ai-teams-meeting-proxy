import type { CaptionItem } from '../audio/captions.js';
import { Vad } from '../audio/vad.js';
import type { BrowserUsage } from '../bot/resources.js';
import { TTS_SAMPLE_RATE } from '../audio/tts.js';
import type { Llm } from '../brain/llm.js';
import { systemPrompt, type MeetingBrief } from '../brain/prompts.js';
import { runTurn, type Decision } from '../brain/turn.js';
import { config } from '../config.js';
import { store, type Meeting, type Question, type Utterance } from '../db.js';

export type AgentState = 'listening' | 'thinking' | 'waiting' | 'speaking';

export type DashboardEvent =
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'partial'; meetingId: number; text: string }
  | { type: 'question'; question: Question }
  | { type: 'agent'; meetingId: number; state: AgentState; muted: boolean };

/** The parts of the Teams bot the session relies on. */
export interface BotLike {
  join(opts: { link: string; displayName: string; lobbyTimeoutMs?: number; onLobby?: () => void }): Promise<void>;
  play(pcm: Buffer, sampleRate: number): Promise<number>;
  stopSpeaking(): Promise<void>;
  queuedSeconds(): Promise<number>;
  /** Memory and CPU of the browser attending this meeting. Absent for rehearsals. */
  resourceUsage?(): Promise<BrowserUsage>;
  setMuted(muted: boolean): Promise<void>;
  raiseHand(raised: boolean): Promise<void>;
  sendChat(text: string): Promise<boolean>;
  leave(): Promise<void>;
  on(event: 'captions', fn: (items: CaptionItem[]) => void): unknown;
  on(event: 'ended', fn: (reason: string) => void): unknown;
  /** People in the meeting including the assistant; 0 when the number is not shown. */
  on(event: 'participants', fn: (count: number) => void): unknown;
}

export interface SttLike {
  start(): void;
  send(pcm: Buffer): void;
  stop(): void;
  /** Seconds of audio sent to a paid service. */
  readonly secondsSent: number;
  /** True when the transcript comes from Teams' captions (free). */
  readonly usesCaptions: boolean;
  pushCaptions?(items: CaptionItem[]): void;
  on(event: 'partial' | 'fatal', fn: (text: string) => void): unknown;
  on(event: 'final', fn: (text: string, speaker?: string) => void): unknown;
  on(event: 'limit', fn: () => void): unknown;
}

export interface SessionDeps {
  createBot(onAudio: (pcm: Buffer) => void): Promise<BotLike>;
  createStt(keyterms: string[]): SttLike;
  /** Free transcriber used once the paid one reaches its limit. */
  createCaptionStt(): SttLike;
  /** Characters the voice may speak in this meeting (default from config). */
  ttsMaxChars?: number;
  createLlm(systemPrompt: string): Llm;
  /** May resolve to `{ free: true }` when the audio cost nothing (served from the local cache). */
  synthesize(
    text: string,
    onChunk: (pcm: Buffer) => void | Promise<void>,
    opts: { signal?: AbortSignal; previousText?: string },
  ): Promise<void | { free?: boolean }>;
  /** Short "thinking" lines said while the answer is being worked out. Empty or absent turns them off. */
  fillers?: readonly string[];
  /** How the spoken introduction opens, e.g. "Good morning everyone". Defaults to the time of day. */
  greeting?: () => string;
  summarize(ownerName: string, title: string, utterances: Utterance[]): Promise<string>;
  notifier: MeetingNotifier;
  broadcast(event: DashboardEvent): void;
  timing?: Partial<Timing>;
  /** Voice allowance shared by all meetings today. */
  voiceBudget?: { canSpend(chars: number): boolean; spend(chars: number): void; readonly max: number };
  /** True while the owner has asked not to be pinged with questions. */
  doNotDisturb?: () => boolean;
  /** The assistant has left: its place can go to another meeting. */
  onEnded?: () => void;
}

export type MeetingPhase = 'lobby' | 'live' | 'ended' | 'failed';

/** How one meeting reaches the owner. Every message is about this meeting only. */
export interface MeetingNotifier {
  send(text: string): Promise<void>;
  sendQuestion(id: number, asker: string, question: string): Promise<void>;
  /** Routine progress, shown as one updating status line rather than a new message each time. */
  status?(phase: MeetingPhase, detail: string): Promise<void>;
}

export interface Timing {
  /** Quiet needed before the agent starts talking. */
  floorSilenceMs: number;
  /** Raise a hand after waiting this long for a gap. */
  raiseHandAfterMs: number;
  /** Give up waiting and post in chat instead. */
  giveUpFloorAfterMs: number;
  /** Quiet room this long with the update undelivered: offer it. */
  lullMs: number;
  lullRetryMs: number;
  /** Lines that do not look addressed to us are batched for this long. */
  batchMs: number;
  /** Leave when nobody has spoken for this long. */
  idleExitMs: number;
  /** Leave this long after everyone else has left. */
  aloneExitMs: number;
  /** Wait before retrying a failed brain. */
  brainRetryMs: number;
  /** Asked something directly and still thinking after this long: say a filler. */
  fillerAfterMs: number;
  /** Speech that has not moved for this long is not reaching the meeting: switch to chat. */
  audioStallMs: number;
  /** Measure the browser's memory and CPU this often; 0 turns it off. */
  resourceSampleMs: number;
}

/** "Good morning everyone" and so on, by the clock. */
export function greetingFor(now = new Date()): string {
  const h = now.getHours();
  return `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'} everyone`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** With the "everyone left" wait set to zero, the room must still have been silent this long. */
const MIN_ALONE_QUIET_MS = 5000;

/** Sentences handed from the brain to the voice while the brain is still writing. */
class SentenceQueue implements AsyncIterable<string> {
  private items: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  push(s: string): void {
    this.items.push(s);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.ended) return;
      else {
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
      }
    }
  }
}

interface SpeechResult {
  /** What was actually said aloud (or posted in chat). */
  spoken: string;
  interrupted: boolean;
  viaChat: boolean;
}

/** One meeting from join to summary: listens, decides, speaks, escalates. */
export class MeetingSession {
  readonly meetingId: number;
  private readonly brief: MeetingBrief;
  private readonly T: Timing;
  private readonly vad = new Vad(16000, config.vadThreshold, config.vadMinSpeechMs);

  private bot: BotLike | null = null;
  private stt: SttLike | null = null;
  private llm: Llm | null = null;

  private state: 'starting' | 'live' | 'ended' = 'starting';
  agentState: AgentState = 'listening';
  muted = false;

  private newLines: { speaker: string; text: string }[] = [];
  private notes: string[] = [];
  private sayQueue: string[] = [];
  private lullPending = 0;
  private working = false;
  private batchTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;

  private updateDelivered = false;
  private introDone = false;
  private heardAnyone = false;
  private liveSince = 0;
  private lastLullAt = 0;
  private lastCaption = { speaker: '', at: 0 };
  private speech: { abort: AbortController; interrupted: boolean; playing: boolean } | null = null;
  private brainDownUntil = 0;
  private toldBrainDown = false;
  private toldVoiceDown = false;
  /** Latest measurement of this meeting's browser, and running totals for the summary. */
  resourceNow: BrowserUsage | null = null;
  private resourceTimer: NodeJS.Timeout | null = null;
  private sampling = false;
  private res = { samples: 0, memSum: 0, peak: 0, cpuSum: 0, cpuSamples: 0 };
  /** The browser's audio engine has stopped: nothing spoken reaches the meeting. */
  private audioStalled = false;
  private toldBudget = false;
  private toldDeaf = false;
  private ttsChars = 0;
  private sttSeconds = 0;
  private speechHeardMs = 0;
  private readonly ttsMaxChars: number;
  private readonly collectQuestions: boolean;
  private readonly rehearsal: boolean;
  private toldNoSound = false;
  private fillerIndex = 0;
  /** Someone other than the assistant has been in the meeting. */
  private othersSeen = false;
  private aloneSince = 0;
  /** When a participant's words last arrived. */
  private lastHeardAt = 0;

  constructor(
    meeting: Meeting,
    private readonly deps: SessionDeps,
  ) {
    this.meetingId = meeting.id;
    this.T = { ...config.timing, ...deps.timing };
    this.ttsMaxChars = deps.ttsMaxChars ?? config.ttsMaxChars;
    this.collectQuestions = meeting.notify_mode === 'collect';
    this.rehearsal = meeting.kind === 'rehearsal';
    this.brief = {
      ownerName: config.ownerName,
      botName: config.botDisplayName,
      title: meeting.title,
      updateText: meeting.update_text,
      context: meeting.context,
      doNotDiscuss: meeting.do_not_discuss,
    };
    // With no update to give there is nothing to volunteer during a lull.
    this.updateDelivered = !meeting.update_text.trim();
  }

  get active(): boolean {
    return this.state !== 'ended';
  }

  get title(): string {
    return this.brief.title || 'your meeting';
  }

  private setAgent(state: AgentState): void {
    this.agentState = state;
    this.deps.broadcast({ type: 'agent', meetingId: this.meetingId, state, muted: this.muted });
  }

  private pushMeeting(): void {
    const m = store.getMeeting(this.meetingId);
    if (m) this.deps.broadcast({ type: 'meeting', meeting: m });
  }

  /** Routine progress: one updating status line where the notifier supports it, else a message. */
  private progress(phase: MeetingPhase, text: string): void {
    const n = this.deps.notifier;
    void (n.status ? n.status(phase, text) : n.send(text));
  }

  /** The owner is not to be pinged: unanswered questions wait for the summary. */
  get holdingQuestions(): boolean {
    return this.collectQuestions || Boolean(this.deps.doNotDisturb?.());
  }

  get pendingQuestions(): Question[] {
    return store.listQuestions(this.meetingId).filter((q) => q.status === 'pending');
  }

  // ---- Lifecycle ------------------------------------------------------------

  /** Join the meeting and run until it ends. Never throws. */
  async run(): Promise<void> {
    try {
      // Start Claude first: its process takes a few seconds to come up, and
      // that overlaps nicely with the browser joining.
      this.llm = this.deps.createLlm(systemPrompt(this.brief));
      this.bot = await this.deps.createBot((pcm) => this.onAudio(pcm));
      this.bot.on('captions', (items) => {
        const speaker = items.at(-1)?.speaker;
        if (speaker && speaker !== config.botDisplayName) this.lastCaption = { speaker, at: Date.now() };
        this.stt?.pushCaptions?.(items);
      });
      this.bot.on('ended', (reason) => void this.stop(reason));
      this.bot.on('participants', (count) => this.onParticipants(count));

      await this.bot.join({
        link: store.getMeeting(this.meetingId)!.link,
        displayName: config.botDisplayName,
        lobbyTimeoutMs: config.lobbyTimeoutMs,
        onLobby: () => {
          store.setStatus(this.meetingId, 'lobby');
          this.pushMeeting();
          this.progress('lobby', `Waiting in the lobby of ${this.title}. Someone needs to admit "${config.botDisplayName}".`);
        },
      });
      if (this.state === 'ended') return; // stopped while joining

      this.attachStt(this.deps.createStt(config.ownerName.split(/\s+/).filter(Boolean)));

      this.state = 'live';
      this.liveSince = Date.now();
      store.setStatus(this.meetingId, 'live');
      this.pushMeeting();
      this.setAgent('listening');
      this.tick = setInterval(() => this.onTick(), 1000);
      this.startMeasuring();
      this.progress(
        'live',
        this.holdingQuestions
          ? `Joined ${this.title}. Questions I cannot answer will be in the summary.`
          : `Joined ${this.title}. I will message you if someone asks something I cannot answer.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.deps.notifier.status?.('failed', `Could not join ${this.title}.`);
      void this.deps.notifier.send(`Could not join ${this.title}: ${message}`);
      await this.stop(message, true);
    }
  }

  private attachStt(stt: SttLike): void {
    this.stt = stt;
    stt.on('partial', (text) => this.deps.broadcast({ type: 'partial', meetingId: this.meetingId, text }));
    stt.on('final', (text, speaker) => this.onFinal(text, speaker));
    stt.on('fatal', (message) => {
      void this.deps.notifier.send(`${message}. The assistant can no longer hear ${this.title}, so it is leaving.`);
      void this.stop(message, true);
    });
    stt.on('limit', () => {
      // Paid transcription budget spent: carry on with Teams' free captions.
      if (this.stt !== stt || this.state === 'ended') return;
      this.sttSeconds += stt.secondsSent;
      stt.stop();
      this.attachStt(this.deps.createCaptionStt());
      void this.deps.notifier.send(
        `The ElevenLabs transcription limit for ${this.title} is used up. The assistant is now following Teams' live captions instead, which is free.`,
      );
    });
    stt.start();
  }

  /** Leave, save usage, write the summary. Safe to call more than once. */
  async stop(reason: string, failed = false): Promise<void> {
    if (this.state === 'ended') return;
    const wasLive = this.state === 'live';
    this.state = 'ended';
    if (this.tick) clearInterval(this.tick);
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.interrupt();
    this.stt?.stop();
    await this.bot?.leave().catch(() => {});
    this.llm?.close();

    store.addUsage(this.meetingId, this.sttSeconds + (this.stt?.secondsSent ?? 0), this.ttsChars);
    if (this.res.samples) {
      store.setResourceUsage(
        this.meetingId,
        this.res.peak,
        this.res.memSum / this.res.samples,
        this.res.cpuSamples ? this.res.cpuSum / this.res.cpuSamples : null,
      );
    }
    store.setStatus(this.meetingId, failed ? 'failed' : 'ended', failed ? reason : null);
    store.setEndReason(this.meetingId, reason);
    this.pushMeeting();
    // Out of the meeting: free the place before the summary, which takes a while.
    this.deps.onEnded?.();
    if (!wasLive) return;
    void this.deps.notifier.status?.(failed ? 'failed' : 'ended', `${this.title} has ended (${reason}).`);

    const utterances = store.listUtterances(this.meetingId);
    let summary = '';
    if (utterances.length) {
      try {
        summary = await this.deps.summarize(config.ownerName, this.brief.title, utterances);
        store.setSummary(this.meetingId, summary);
        this.pushMeeting();
      } catch (err) {
        summary = `(The summary could not be written: ${(err as Error).message}. The full transcript is on the History page.)`;
      }
    }
    const open = store.listQuestions(this.meetingId).filter((q) => q.status === 'pending');
    const openText = open.length
      ? `\n\nStill waiting on your answer:\n${open.map((q) => `- ${q.asker}: ${q.question}`).join('\n')}`
      : '';
    await this.deps.notifier.send(
      `${this.title} has ended (${reason}).\n\n${summary || 'Nothing was said while the assistant was there.'}${openText}`,
    );
  }

  // ---- Machine resources -----------------------------------------------------

  /** Sample the browser's memory and CPU now and then. Never affects the meeting. */
  private startMeasuring(): void {
    const usage = this.bot?.resourceUsage?.bind(this.bot);
    if (!usage || this.T.resourceSampleMs <= 0) return;
    const sample = async () => {
      if (this.sampling || this.state !== 'live') return;
      this.sampling = true;
      try {
        const now = await usage();
        if (this.state !== 'live') return;
        this.resourceNow = now;
        this.res.samples++;
        this.res.memSum += now.memMb;
        this.res.peak = Math.max(this.res.peak, now.memMb);
        if (now.cores !== null) {
          this.res.cpuSum += now.cores;
          this.res.cpuSamples++;
        }
      } catch {
        // A missed measurement is not worth anything going wrong for.
      } finally {
        this.sampling = false;
      }
    };
    void sample();
    this.resourceTimer = setInterval(() => void sample(), this.T.resourceSampleMs);
  }

  // ---- Who is here ----------------------------------------------------------

  /**
   * Leave once everyone else has gone. `count` is the number Teams shows on its
   * People button, which includes the assistant: 1 means alone, 0 means no
   * number is shown.
   *
   * That number is read off a page Microsoft controls, so it is never trusted
   * on its own. The assistant leaves only when all of these hold:
   *   - the number was 2 or more at some point (so it is being read correctly
   *     and someone really was here),
   *   - it now says exactly 1 (a missing number proves nothing),
   *   - and nobody has been heard, in audio or captions, for the whole wait.
   * Anyone speaking is proof the room is not empty, whatever the number says.
   */
  private onParticipants(count: number): void {
    if (this.state === 'ended') return;
    if (count >= 2) {
      this.othersSeen = true;
      this.aloneSince = 0;
      return;
    }
    if (this.state !== 'live' || !this.othersSeen || count !== 1) {
      this.aloneSince = 0;
      return;
    }
    const now = Date.now();
    const wait = Math.max(this.T.aloneExitMs, 0);
    // With the wait set to zero there must still have been a few seconds of silence.
    if (this.quietMs(now) < (wait || MIN_ALONE_QUIET_MS) || this.working) {
      // Someone is talking, or the assistant is in the middle of answering: not alone.
      this.aloneSince = 0;
      return;
    }
    this.aloneSince ||= now;
    if (now - this.aloneSince >= wait) {
      void this.stop('everyone else left the meeting');
    }
  }

  // ---- Listening ------------------------------------------------------------

  private onAudio(pcm: Buffer): void {
    if (this.state !== 'live') return;
    this.stt?.send(pcm);
    const someoneTalking = this.vad.push(pcm);
    if (someoneTalking) this.speechHeardMs += (pcm.length / 2 / 16000) * 1000;
    // Barge-in: a person started talking over the agent, so yield at once.
    if (someoneTalking && this.speech?.playing) {
      this.interrupt();
    }
  }

  private currentSpeaker(): string {
    return Date.now() - this.lastCaption.at < 6000 && this.lastCaption.speaker ? this.lastCaption.speaker : 'Someone';
  }

  private onFinal(text: string, knownSpeaker?: string): void {
    if (this.state !== 'live') return;
    const speaker = knownSpeaker || this.currentSpeaker();
    this.heardAnyone = true;
    this.lastHeardAt = Date.now();
    // Words without any detected sound: the meeting still works from captions,
    // but the assistant cannot tell when it is being talked over. Worth knowing.
    if (!this.rehearsal && !this.toldNoSound && this.speechHeardMs === 0) {
      this.toldNoSound = true;
      console.warn(
        `[audio] ${this.title}: captions are arriving but no sound has been detected from the meeting. ` +
          'The assistant will still answer, but it will not stop when someone talks over it. ' +
          'If voices are simply quiet, lower VAD_THRESHOLD in .env.',
      );
    }
    const utterance = store.addUtterance(this.meetingId, speaker, text);
    this.deps.broadcast({ type: 'utterance', utterance });
    this.deps.broadcast({ type: 'partial', meetingId: this.meetingId, text: '' });
    this.newLines.push({ speaker, text });

    if (this.looksAddressedToUs(text)) {
      this.kick();
    } else if (!this.batchTimer) {
      // Ordinary chatter: wait a little and judge several lines in one go,
      // which keeps subscription usage down in long meetings.
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.kick();
      }, this.T.batchMs);
    }
  }

  private looksAddressedToUs(text: string): boolean {
    const t = text.toLowerCase();
    if (t.includes('?')) return true;
    const first = config.ownerName.split(/\s+/)[0]?.toLowerCase();
    if (first && t.includes(first)) return true;
    return /\b(assistant|update|updates|status|anyone|anything else|go ahead|who'?s next|next up)\b/.test(t);
  }

  /** Someone asked us or the owner something by name: a reply is almost certainly coming. */
  private isDirectQuestion(text: string): boolean {
    const t = text.toLowerCase();
    const first = config.ownerName.split(/\s+/)[0]?.toLowerCase();
    const named = (first && t.includes(first)) || /\bassistant\b/.test(t);
    if (!named) return false;
    return t.includes('?') || /\b(update|status|can you|could you|do you|did you|will you|are you|what|when|where|who|why|how)\b/.test(t);
  }

  /**
   * How long since anyone was last heard, by sound or by words. The two are
   * measured separately (the speech detector listens to the audio, the words
   * come from captions), and either one alone is enough to show someone spoke:
   * a quiet voice can be captioned without ever tripping the speech detector.
   * Infinity if nobody has been heard at all.
   */
  private quietMs(now = Date.now()): number {
    return Math.min(this.vad.silenceMs(now), this.lastHeardAt ? now - this.lastHeardAt : Infinity);
  }

  private onTick(): void {
    if (this.state !== 'live') return;
    const now = Date.now();
    const quiet = this.quietMs(now);

    if (this.heardAnyone ? quiet > this.T.idleExitMs : now - this.liveSince > 3 * this.T.idleExitMs) {
      void this.stop(`nobody spoke for ${Math.round(this.T.idleExitMs / 60_000)} minutes`);
      return;
    }

    // People are audibly talking but no captions have arrived: the assistant is deaf.
    if (this.stt?.usesCaptions && !this.heardAnyone && !this.toldDeaf && this.speechHeardMs > 20_000) {
      this.toldDeaf = true;
      void this.deps.notifier.send(
        `People are talking in ${this.title} but the assistant cannot read Teams' live captions, so it cannot follow the meeting. Captions may be disabled for guests, or the Teams page has changed. To use paid ElevenLabs transcription instead, set STT_MODE=elevenlabs in .env and rejoin.`,
      );
    }

    // The room has gone quiet and the update is still owed: offer it.
    if (
      !this.updateDelivered &&
      !this.muted &&
      !this.working &&
      this.heardAnyone &&
      quiet >= this.T.lullMs &&
      quiet !== Infinity &&
      now - this.lastLullAt > this.T.lullRetryMs
    ) {
      this.lastLullAt = now;
      this.lullPending = quiet / 1000;
      this.kick();
    }
  }

  // ---- Work loop: one thing at a time ---------------------------------------

  private kick(): void {
    if (this.working || this.state !== 'live') return;
    this.working = true;
    void (async () => {
      try {
        while (this.state === 'live') {
          const direct = this.sayQueue.shift();
          if (direct !== undefined) {
            const res = await this.speak([direct]);
            if (res.spoken) this.notes.push(`On ${this.brief.ownerName}'s instruction you just said: "${res.spoken}"`);
          } else if ((this.newLines.length || this.lullPending) && Date.now() >= this.brainDownUntil) {
            // While the brain is down, lines simply accumulate for the retry.
            await this.think();
          } else {
            break;
          }
        }
      } finally {
        this.working = false;
        this.setAgent('listening');
      }
    })();
  }

  private async think(): Promise<void> {
    const lines = this.newLines.splice(0);
    const lullSeconds = this.lullPending || undefined;
    this.lullPending = 0;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const notes = this.notes.splice(0);
    if (this.muted) notes.push(`${this.brief.ownerName} has muted you: nothing in SAY will be heard, but still escalate questions.`);
    const holding = this.holdingQuestions;
    if (holding) {
      notes.push(
        `${this.brief.ownerName} cannot be reached during this meeting. When you escalate, do not say you have messaged them or will pass on a reply; say ${this.brief.ownerName} will follow up after the meeting.`,
      );
    }
    this.setAgent('thinking');

    const canSpeak = !this.muted;
    const queue = new SentenceQueue();
    const speaking = canSpeak ? this.speak(queue) : null;
    let decision: Decision = { action: 'silent' };

    // A person asked directly and the answer is taking a moment: say what people
    // say while they think, so the room does not sit in silence. Not before the
    // introduction, which is long enough on its own.
    let filler = '';
    let fillerTimer: NodeJS.Timeout | null = null;
    const cancelFiller = () => {
      if (fillerTimer) clearTimeout(fillerTimer);
      fillerTimer = null;
    };
    const fillers = this.deps.fillers ?? [];
    if (canSpeak && this.introDone && fillers.length && !lullSeconds && lines.some((l) => this.isDirectQuestion(l.text))) {
      fillerTimer = setTimeout(() => {
        fillerTimer = null;
        filler = fillers[this.fillerIndex++ % fillers.length];
        queue.push(filler);
      }, this.T.fillerAfterMs);
    }
    try {
      decision = await runTurn(
        this.llm!,
        {
          updateDelivered: this.updateDelivered,
          lullSeconds,
          pendingQuestions: store
            .listQuestions(this.meetingId)
            .filter((q) => q.status === 'pending')
            .map((q) => q.question),
          lines,
          note: notes.join(' ') || undefined,
        },
        canSpeak
          ? (s) => {
              cancelFiller();
              queue.push(s);
            }
          : undefined,
        // Decided to stay silent before the filler was due: say nothing at all.
        (action) => action === 'silent' && cancelFiller(),
      );
      this.toldBrainDown = false;
    } catch (err) {
      this.brainFailed(err as Error, lines);
    } finally {
      cancelFiller();
      queue.end();
    }

    if (decision.action === 'escalate') {
      const question = store.addQuestion(this.meetingId, decision.asker, decision.question);
      this.deps.broadcast({ type: 'question', question });
      // When held, the question waits in the dashboard and the summary instead of pinging the owner.
      if (!holding) void this.deps.notifier.sendQuestion(question.id, decision.asker, decision.question);
    }

    const res = speaking ? await speaking : null;
    if (decision.action === 'leave') {
      // A participant told the assistant to go. The goodbye (if not muted) has
      // finished playing by now, so leave for real; the summary follows as usual.
      void this.stop('someone in the meeting asked the assistant to leave');
      return;
    }
    if (!res) return;
    if (filler && res.spoken === filler && !res.interrupted) {
      this.notes.push(`While thinking you said "${filler}" aloud and then nothing else.`);
    }
    if (res.interrupted) {
      this.notes.push(
        res.spoken
          ? `Someone started talking over you, so you stopped after saying: "${res.spoken}"`
          : 'Someone started talking just as you began, so you said nothing.',
      );
    } else if (res.viaChat) {
      this.notes.push('There was no gap to speak, so your last reply was posted in the meeting chat instead.');
    }
    if (decision.action !== 'silent' && decision.deliversUpdate && res.spoken && !res.interrupted) {
      this.updateDelivered = true;
    }
  }

  private brainFailed(err: Error, lostLines: { speaker: string; text: string }[]): void {
    console.warn('[brain]', err.message);
    this.brainDownUntil = Date.now() + this.T.brainRetryMs;
    // The conversation may be dead (usage limit, crashed process): start a new
    // one and hand it the recent transcript so it is not lost.
    this.llm?.close();
    this.llm = this.deps.createLlm(systemPrompt(this.brief));
    const recent = store.listUtterances(this.meetingId).slice(-40);
    this.notes.push(
      'You were briefly offline. Recent transcript for context (already handled, do not respond to it): ' +
        recent.map((u) => `${u.speaker}: ${u.text}`).join(' / '),
    );
    this.newLines.unshift(...lostLines.slice(-5));
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.kick();
    }, this.T.brainRetryMs + 50);
    if (this.toldBrainDown) return;
    this.toldBrainDown = true;
    void this.deps.notifier.send(
      `Claude is not responding in ${this.title} (${err.message}). The assistant is still transcribing and will retry in ${Math.round(this.T.brainRetryMs / 60_000)} minutes. You can still use /say.`,
    );
    void this.bot?.sendChat(
      `(${config.botDisplayName}) I can't answer questions right now. ${this.brief.ownerName} will follow up on anything addressed to them.`,
    );
  }

  // ---- Speaking -------------------------------------------------------------

  private interrupt(): void {
    if (!this.speech || this.speech.interrupted) return;
    this.speech.interrupted = true;
    this.speech.abort.abort();
    void this.bot?.stopSpeaking();
  }

  /** Wait for a gap in the conversation. False if none came. */
  private async waitForFloor(): Promise<boolean> {
    const start = Date.now();
    let raised = false;
    try {
      while (this.state === 'live' && !this.muted) {
        if (this.vad.silenceMs() >= this.T.floorSilenceMs) return true;
        const waited = Date.now() - start;
        if (!raised && waited > this.T.raiseHandAfterMs) {
          raised = true;
          void this.bot?.raiseHand(true);
        }
        if (waited > this.T.giveUpFloorAfterMs) return false;
        await sleep(100);
      }
      return false;
    } finally {
      if (raised) void this.bot?.raiseHand(false);
    }
  }

  private async speak(source: AsyncIterable<string> | string[]): Promise<SpeechResult> {
    const speech = { abort: new AbortController(), interrupted: false, playing: false };
    const said: string[] = [];
    let started = false;
    let viaChat = false;
    const chatLines: string[] = [];

    try {
      for await (let sentence of source) {
        if (viaChat) {
          chatLines.push(sentence);
          continue;
        }
        if (speech.interrupted || this.muted || this.state !== 'live') continue; // drain the rest unspoken
        if (this.audioStalled) {
          // Speaking is known not to work in this meeting: do not pay for audio nobody hears.
          viaChat = true;
          chatLines.push(sentence);
          continue;
        }

        if (!started) {
          started = true;
          this.setAgent('waiting');
          if (!(await this.waitForFloor())) {
            if (this.muted || this.state !== 'live') continue;
            viaChat = true;
            chatLines.push(sentence);
            continue;
          }
          this.speech = speech;
          await this.bot!.setMuted(false);
          if (!this.introDone) {
            this.introDone = true;
            sentence = `${(this.deps.greeting ?? greetingFor)()}, this is ${this.brief.ownerName}'s AI assistant, speaking on ${this.brief.ownerName}'s behalf. ${sentence}`;
          }
          this.setAgent('speaking');
        }

        // Voice budget spent (this meeting's, or today's across all meetings): the rest goes to chat for free.
        const overMeeting = this.ttsChars + sentence.length > this.ttsMaxChars;
        const overDay = !overMeeting && this.deps.voiceBudget !== undefined && !this.deps.voiceBudget.canSpend(sentence.length);
        if (overMeeting || overDay) {
          if (!this.toldBudget) {
            this.toldBudget = true;
            void this.deps.notifier.send(
              overMeeting
                ? `The voice limit for ${this.title} (${this.ttsMaxChars} characters) is used up. Further replies go to the meeting chat. Raise TTS_MAX_CHARS in .env to allow more.`
                : `Today's voice limit across all meetings (${this.deps.voiceBudget!.max} characters) is used up. Replies in ${this.title} now go to the meeting chat. Raise TTS_DAILY_MAX_CHARS in .env to allow more.`,
            );
          }
          viaChat = true;
          chatLines.push(sentence);
          continue;
        }

        try {
          const result = await this.deps.synthesize(
            sentence,
            async (pcm) => {
              if (speech.interrupted) return;
              await this.bot!.play(pcm, TTS_SAMPLE_RATE);
              speech.playing = true;
            },
            { signal: speech.abort.signal, previousText: said.join(' ') || undefined },
          );
          // Audio replayed from the local cache costs no credits.
          if (!(result && result.free)) {
            this.ttsChars += sentence.length;
            this.deps.voiceBudget?.spend(sentence.length);
          }
          if (!speech.interrupted) said.push(sentence);
        } catch (err) {
          if (speech.interrupted) continue;
          // The voice failed (credits, network): fall back to chat.
          console.warn('[tts]', (err as Error).message);
          if (!this.toldVoiceDown) {
            this.toldVoiceDown = true;
            void this.deps.notifier.send(`The voice failed in ${this.title}: ${(err as Error).message}. Replies will go to the meeting chat instead.`);
          }
          viaChat = true;
          chatLines.push(sentence);
        }
      }

      // Let the queued audio finish playing. If the amount still queued stops
      // going down, the audio engine in the browser has stalled and the room is
      // hearing nothing: say so, and put what should have been said in the chat.
      let lowest = Infinity;
      let movedAt = Date.now();
      while (!speech.interrupted && this.state === 'live') {
        const queued = await this.bot!.queuedSeconds();
        if (queued <= 0.05) break;
        if (queued < lowest - 0.05) {
          lowest = queued;
          movedAt = Date.now();
        } else if (Date.now() - movedAt > this.T.audioStallMs) {
          this.audioStalled = true;
          await this.bot!.stopSpeaking();
          console.warn(`[audio] ${this.title}: speech is not playing into the meeting (audio engine stalled).`);
          void this.deps.notifier.send(
            `The assistant's voice is not reaching ${this.title}: the audio in its browser window has stalled. Replies will go to the meeting chat instead. Leaving and rejoining usually fixes it.`,
          );
          viaChat = true;
          chatLines.unshift(...said.splice(0));
          break;
        }
        await sleep(100);
      }
    } finally {
      if (this.speech === speech) this.speech = null;
    }

    let spoken = said.join(' ');
    if (viaChat && chatLines.length) {
      const text = chatLines.join(' ');
      const posted = await this.bot!.sendChat(`(${config.botDisplayName}) ${text}`);
      if (posted) spoken = [spoken, text].filter(Boolean).join(' ');
      else viaChat = false;
    }
    if (spoken) {
      const utterance = store.addUtterance(this.meetingId, config.botDisplayName, spoken, true);
      this.deps.broadcast({ type: 'utterance', utterance });
    }
    return { spoken, interrupted: speech.interrupted, viaChat };
  }

  // ---- Rehearsal ------------------------------------------------------------

  /** A participant's line typed in by the owner instead of heard in a call. */
  hear(speaker: string, text: string): void {
    this.vad.markSpeech();
    this.onFinal(text, speaker);
  }

  /** Pretend the room has been quiet long enough to offer the update. False if there is nothing to offer. */
  simulateLull(): boolean {
    if (this.state !== 'live' || this.updateDelivered || this.muted) return false;
    this.lastLullAt = Date.now();
    this.lullPending = this.T.lullMs / 1000;
    this.kick();
    return true;
  }

  // ---- Owner controls -------------------------------------------------------

  /** Say this in the meeting, in the owner's words, at the next gap. */
  sayNow(text: string): void {
    this.sayQueue.push(text);
    this.kick();
  }

  /** Kill switch: stop talking immediately and stay quiet until unmuted. */
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    if (muted) {
      this.sayQueue.length = 0;
      this.interrupt();
    }
    await this.bot?.setMuted(muted).catch(() => {});
    this.setAgent(this.agentState);
  }

  /** The owner answered an escalated question: pass it on. */
  relayAnswer(question: Question, answer: string): void {
    store.answerQuestion(question.id, answer, 'relayed');
    this.deps.broadcast({ type: 'question', question: store.getQuestion(question.id)! });
    this.notes.push(`${this.brief.ownerName} answered the escalated question "${question.question}".`);
    // Several questions may be open, so say which one this answers before giving the answer.
    const first = this.brief.ownerName.split(/\s+/)[0];
    const asked = /[.?!]$/.test(question.question.trim()) ? question.question.trim() : `${question.question.trim()}?`;
    const who = question.asker === 'Someone' ? 'The question was' : `${question.asker} asked`;
    this.sayNow(`${first} just got back to me. ${who}: ${asked} ${first}'s answer: ${answer}`);
  }

  /** The owner will deal with an escalated question later: close it and tell the room. */
  followUpLater(question: Question): void {
    store.answerQuestion(question.id, 'You chose to follow up after the meeting.', 'answered');
    this.deps.broadcast({ type: 'question', question: store.getQuestion(question.id)! });
    this.notes.push(`${this.brief.ownerName} will answer the escalated question "${question.question}" after the meeting.`);
    if (this.muted) return;
    this.sayNow(
      `On ${question.asker === 'Someone' ? 'the' : `${question.asker}'s`} earlier question, ${this.brief.ownerName.split(/\s+/)[0]} will follow up after the meeting.`,
    );
  }
}
