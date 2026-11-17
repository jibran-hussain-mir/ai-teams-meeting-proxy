import { store } from '../db.js';
import type { AgentState, MeetingNotifier, MeetingPhase } from '../meeting/session.js';

/**
 * The owner's side of every running meeting, in one chat. All the decisions
 * live here (which meeting a message is about, what a reply or button press
 * means); sending and receiving is left to a Transport so this can be tested
 * without Telegram.
 */

export interface Button {
  text: string;
  /** Sent back when pressed. Telegram allows at most 64 bytes. */
  data: string;
}
export type Buttons = Button[][];

export interface Outgoing {
  text: string;
  buttons?: Buttons;
}

/** Answer to a button press. `replace` swaps the pressed message for this one instead of adding a new message. */
export interface ButtonResult extends Outgoing {
  replace: boolean;
}

export interface Transport {
  readonly enabled: boolean;
  /** Returns the ids of the messages sent (a long text is split), empty if nothing went out. */
  send(msg: Outgoing): Promise<number[]>;
  edit(messageId: number, msg: Outgoing): Promise<void>;
}

export interface LiveInfo {
  id: number;
  /** Colour and name, e.g. "🟦 Standup". */
  tag: string;
  phase: 'joining' | 'lobby' | 'live';
  agent: AgentState;
  muted: boolean;
  /** Questions waiting for the owner. */
  pending: number;
  startedAt: number;
}

export interface PendingQuestion {
  id: number;
  meetingId: number;
  asker: string;
  question: string;
}

/** What the hub can ask the rest of the app to do. Every string returned is shown to the owner. */
export interface HubControl {
  live(): LiveInfo[];
  upcoming(): { title: string; at: Date }[];
  pending(): PendingQuestion[];
  say(meetingId: number, text: string): string;
  mute(meetingId: number, muted: boolean): Promise<string>;
  leave(meetingId: number): string;
  answer(questionId: number, text: string): string;
  followUp(questionId: number): string;
  catchUp(meetingId: number): Promise<string>;
}

export const HELP = `Every message starts with the meeting it is about.

Reply to a question to have your answer spoken in that meeting.
Reply to any other message from a meeting to say something there.

/meetings - what is running and what is coming up
/catchup - what has been said in the last few minutes
/say <text> - say this in a meeting
/mute, /unmute - silence the assistant, or let it speak again
/leave - leave a meeting
/dnd on|off - hold questions for the summary instead of messaging you

With several meetings running, I will ask which one you mean.`;

const NONE_RUNNING = 'No meeting is running. Send /meetings to see what is coming up.';
const GONE = 'That meeting is no longer running.';

function clip(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function describe(m: LiveInfo, now: number): string {
  if (m.phase === 'joining') return 'joining';
  if (m.phase === 'lobby') return 'waiting in the lobby';
  const mins = Math.max(0, Math.round((now - m.startedAt) / 60_000));
  const parts = [`live ${mins} min`, m.muted ? 'muted' : m.agent];
  if (m.pending) parts.push(plural(m.pending, 'open question'));
  return parts.join(', ');
}

interface Card {
  tag: string;
  phase: MeetingPhase;
  detail: string;
  messageId: number | null;
  /** Serialises updates so two quick changes cannot both create the card. */
  queue: Promise<void>;
}

export class TelegramHub {
  private readonly cards = new Map<number, Card>();
  /** Text waiting for the owner to pick a meeting (button data is too small to carry it). */
  private readonly held = new Map<string, string>();
  private nextToken = 1;
  /** Do not disturb: questions are kept for the summary. */
  dnd = false;

  constructor(
    private readonly transport: Transport,
    private readonly control: HubControl,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- Outgoing: one notifier per meeting -------------------------------------

  /** Everything this notifier sends is labelled with the meeting and remembered, so replies find their way back. */
  forMeeting(meetingId: number, tag: string): MeetingNotifier {
    return {
      send: async (text) => {
        await this.post(meetingId, { text: `${tag}\n${text}` });
      },
      sendQuestion: async (id, asker, question) => {
        await this.post(
          meetingId,
          {
            text: `${tag} · Question from ${asker || 'someone'}\n\n${question}\n\nReply to this message to answer.`,
            buttons: [
              [
                { text: "I'll follow up later", data: `later:${id}` },
                { text: 'Catch me up', data: `catch:${meetingId}` },
              ],
            ],
          },
          id,
        );
        this.refreshCard(meetingId);
      },
      status: async (phase, detail) => {
        const card = this.cards.get(meetingId) ?? { tag, phase, detail, messageId: null, queue: Promise.resolve() };
        card.phase = phase;
        card.detail = detail;
        this.cards.set(meetingId, card);
        await this.drawCard(meetingId);
      },
    };
  }

  /** A message that is not about one meeting (for example from the scheduler). */
  async announce(text: string): Promise<void> {
    await this.transport.send({ text });
  }

  private async post(meetingId: number, msg: Outgoing, questionId: number | null = null): Promise<void> {
    for (const id of await this.transport.send(msg)) store.saveTgMessage(id, meetingId, questionId);
  }

  // ---- Status card: one message per meeting, updated in place -----------------

  private renderCard(meetingId: number, card: Card): Outgoing {
    const info = this.control.live().find((m) => m.id === meetingId);
    if (card.phase === 'ended' || card.phase === 'failed' || !info) {
      return { text: `${card.tag}\n${card.phase === 'failed' ? 'Failed' : 'Ended'}\n${card.detail}` };
    }
    if (card.phase === 'lobby') {
      return { text: `${card.tag}\nIn the lobby\n${card.detail}`, buttons: [[{ text: 'Leave', data: `leave:${meetingId}` }]] };
    }
    const state = info.muted ? 'muted' : info.agent;
    const questions = info.pending ? ` · ${plural(info.pending, 'open question')}` : '';
    return {
      text: `${card.tag}\nLive since ${clock(new Date(info.startedAt))} · ${state}${questions}\n${card.detail}`,
      buttons: [
        [
          info.muted ? { text: 'Unmute', data: `unmute:${meetingId}` } : { text: 'Mute', data: `mute:${meetingId}` },
          { text: 'Catch me up', data: `catch:${meetingId}` },
          { text: 'Leave', data: `leave:${meetingId}` },
        ],
      ],
    };
  }

  private drawCard(meetingId: number): Promise<void> {
    const card = this.cards.get(meetingId);
    if (!card) return Promise.resolve();
    card.queue = card.queue
      .then(async () => {
        const msg = this.renderCard(meetingId, card);
        if (card.messageId === null) {
          const [id] = await this.transport.send(msg);
          if (id !== undefined) {
            card.messageId = id;
            store.saveTgMessage(id, meetingId);
          }
        } else {
          await this.transport.edit(card.messageId, msg);
        }
        if (card.phase === 'ended' || card.phase === 'failed') this.cards.delete(meetingId);
      })
      .catch(() => {});
    return card.queue;
  }

  /** Something on the card changed (muted, a question answered): redraw it. */
  refreshCard(meetingId: number): void {
    void this.drawCard(meetingId);
  }

  // ---- Incoming ---------------------------------------------------------------

  private hold(text: string): string {
    const token = String(this.nextToken++);
    this.held.set(token, text);
    // Old prompts nobody answered are dropped.
    if (this.held.size > 50) this.held.delete(this.held.keys().next().value!);
    return token;
  }

  /** Buttons to pick one of the running meetings (or all of them). */
  private chooser(live: LiveInfo[], data: (target: string) => string, all = true): Buttons {
    const rows: Buttons = live.map((m) => [{ text: m.tag, data: `c.${data(String(m.id))}` }]);
    if (all && live.length > 1) rows.push([{ text: 'All meetings', data: `c.${data('all')}` }]);
    rows.push([{ text: 'Cancel', data: 'c.cancel' }]);
    return rows;
  }

  async command(name: string, arg = ''): Promise<Outgoing> {
    const live = this.control.live();
    const text = arg.trim();

    switch (name) {
      case 'help':
        return { text: HELP };

      case 'meetings':
      case 'status':
        return this.overview();

      case 'dnd': {
        if (/^(on|off)$/i.test(text)) this.dnd = text.toLowerCase() === 'on';
        else if (text) return { text: 'Usage: /dnd on or /dnd off' };
        return {
          text: this.dnd
            ? 'Do not disturb is on. Questions I cannot answer will wait for the summary, and I will tell people you will follow up after the meeting. Send /dnd off to be asked live again.'
            : 'Do not disturb is off. I will message you when someone asks something I cannot answer. Send /dnd on to hold questions for the summary.',
        };
      }

      case 'say':
        if (!text) return { text: 'Usage: /say <text>' };
        if (!live.length) return { text: NONE_RUNNING };
        if (live.length === 1) return { text: `${live[0].tag} · ${this.control.say(live[0].id, text)}` };
        return this.askWhere(live, text);

      case 'mute':
      case 'unmute':
      case 'leave':
      case 'catchup': {
        if (!live.length) return { text: NONE_RUNNING };
        const action = name === 'catchup' ? 'catch' : name;
        if (live.length === 1) return this.act(action, live[0].id);
        const ask = { mute: 'Mute which meeting?', unmute: 'Unmute which meeting?', leave: 'Leave which meeting?', catch: 'Catch up on which meeting?' }[action]!;
        return { text: ask, buttons: this.chooser(live, (t) => `${action}:${t}`, action !== 'catch') };
      }

      default:
        return { text: HELP };
    }
  }

  private overview(): Outgoing {
    const live = this.control.live();
    const upcoming = this.control.upcoming();
    const now = this.now();
    const lines: string[] = [];
    const buttons: Buttons = [];

    if (live.length) {
      lines.push(`${plural(live.length, 'meeting')} running`, '');
      for (const m of live) {
        lines.push(`${m.tag} — ${describe(m, now)}`);
        if (m.phase === 'live') {
          buttons.push([
            { text: `${m.tag.split(' ')[0]} Catch up`, data: `catch:${m.id}` },
            m.muted ? { text: 'Unmute', data: `unmute:${m.id}` } : { text: 'Mute', data: `mute:${m.id}` },
            { text: 'Leave', data: `leave:${m.id}` },
          ]);
        } else {
          buttons.push([{ text: `${m.tag.split(' ')[0]} Leave`, data: `leave:${m.id}` }]);
        }
      }
    } else {
      lines.push('No meeting is running.');
    }

    if (upcoming.length) {
      lines.push('', 'Coming up');
      for (const u of upcoming.slice(0, 8)) {
        lines.push(`• ${u.title || 'Meeting'} — ${u.at.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
      }
    }
    if (this.dnd) lines.push('', 'Do not disturb is on: questions wait for the summary.');
    return { text: lines.join('\n'), buttons: buttons.length ? buttons : undefined };
  }

  /** Carry out an action on one meeting and describe the result. */
  private async act(action: string, meetingId: number): Promise<Outgoing> {
    const m = this.control.live().find((x) => x.id === meetingId);
    if (!m) return { text: GONE };
    switch (action) {
      case 'mute':
      case 'unmute': {
        const result = await this.control.mute(meetingId, action === 'mute');
        this.refreshCard(meetingId);
        return { text: `${m.tag} · ${result}` };
      }
      case 'leave':
        return { text: `${m.tag} · ${this.control.leave(meetingId)}` };
      case 'catch':
        return { text: `${m.tag} · Catch-up\n\n${await this.control.catchUp(meetingId)}` };
      default:
        return { text: 'I did not understand that button.' };
    }
  }

  /** A plain message from the owner, possibly a reply to one of ours. */
  async text(text: string, replyTo?: number): Promise<Outgoing> {
    const live = this.control.live();
    const origin = replyTo !== undefined ? store.getTgMessage(replyTo) : undefined;

    if (origin?.question_id != null) {
      const question = store.getQuestion(origin.question_id);
      if (question?.status === 'pending') return { text: this.answered(question.id, question.meeting_id, text) };
      // Already dealt with: treat the reply as something to say in that meeting.
    }

    if (origin) {
      const m = live.find((x) => x.id === origin.meeting_id);
      if (!m) return { text: 'That meeting is over, so nothing was said.' };
      return {
        text: `Say "${clip(text)}" in ${m.tag}?`,
        buttons: [
          [
            { text: 'Say it', data: `c.say:${m.id}:${this.hold(text)}` },
            { text: 'Cancel', data: 'c.cancel' },
          ],
        ],
      };
    }

    // Not a reply: work out what it most likely is.
    const pending = this.control.pending();
    if (pending.length === 1) return { text: this.answered(pending[0].id, pending[0].meetingId, text) };
    if (pending.length > 1) {
      const token = this.hold(text);
      return {
        text: `Which question is "${clip(text, 40)}" the answer to?`,
        buttons: [
          ...pending.slice(0, 8).map((q) => {
            const tag = live.find((m) => m.id === q.meetingId)?.tag.split(' ')[0] ?? '';
            return [{ text: clip(`${tag} ${q.asker}: ${q.question}`, 48), data: `c.ans:${q.id}:${token}` }];
          }),
          [{ text: 'Cancel', data: 'c.cancel' }],
        ],
      };
    }
    if (!live.length) return { text: NONE_RUNNING };
    return this.askWhere(live, text);
  }

  /** Ask where to say something. The text is held once and every button refers to it. */
  private askWhere(live: LiveInfo[], text: string): Outgoing {
    const token = this.hold(text);
    return {
      text: live.length === 1 ? `Say "${clip(text)}" in ${live[0].tag}?` : `Say "${clip(text)}" in which meeting?`,
      buttons: this.chooser(live, (t) => `say:${t}:${token}`),
    };
  }

  private answered(questionId: number, meetingId: number, text: string): string {
    const tag = this.control.live().find((m) => m.id === meetingId)?.tag;
    const result = this.control.answer(questionId, text);
    this.refreshCard(meetingId);
    return tag ? `${tag} · ${result}` : result;
  }

  /** A button was pressed. */
  async button(data: string): Promise<ButtonResult> {
    // Buttons on a "which meeting?" prompt replace the prompt with the outcome.
    const replace = data.startsWith('c.');
    const [action, target = '', token = ''] = (replace ? data.slice(2) : data).split(':');
    const done = (out: Outgoing): ButtonResult => ({ ...out, replace });

    if (action === 'cancel') return done({ text: 'Cancelled.' });

    if (action === 'later') {
      const question = store.getQuestion(Number(target));
      if (!question) return done({ text: 'That question no longer exists.' });
      const tag = this.control.live().find((m) => m.id === question.meeting_id)?.tag;
      const result = this.control.followUp(question.id);
      this.refreshCard(question.meeting_id);
      return done({ text: tag ? `${tag} · ${result}` : result });
    }

    if (action === 'ans' || action === 'say') {
      const text = this.held.get(token);
      if (text === undefined) return done({ text: 'That has expired. Please send it again.' });
      this.held.delete(token);
      if (action === 'ans') {
        const question = store.getQuestion(Number(target));
        if (!question) return done({ text: 'That question no longer exists.' });
        return done({ text: this.answered(question.id, question.meeting_id, text) });
      }
      const live = this.control.live();
      const targets = target === 'all' ? live : live.filter((m) => m.id === Number(target));
      if (!targets.length) return done({ text: GONE });
      return done({ text: targets.map((m) => `${m.tag} · ${this.control.say(m.id, text)}`).join('\n') });
    }

    if (target === 'all') {
      const results: string[] = [];
      for (const m of this.control.live()) results.push((await this.act(action, m.id)).text);
      return done({ text: results.join('\n') || NONE_RUNNING });
    }
    return done(await this.act(action, Number(target)));
  }
}
