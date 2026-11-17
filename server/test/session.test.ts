import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Llm } from '../src/brain/llm.js';
import { store } from '../src/db.js';
import { MeetingSession, type BotLike, type DashboardEvent, type SttLike } from '../src/meeting/session.js';

const SILENT = 'ACTION: silent\nDELIVERS_UPDATE: no';

function loudFrame(ms = 100): Buffer {
  const n = (16000 * ms) / 1000;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 5) * 0.4 * 0x7fff), i * 2);
  return buf;
}

/** A meeting with every external service replaced by a scripted fake. */
async function harness(
  replies: string[],
  opts: {
    slowVoice?: boolean;
    ttsMaxChars?: number;
    notifyMode?: 'live' | 'collect';
    doNotDisturb?: () => boolean;
    voiceBudget?: { canSpend(chars: number): boolean; spend(chars: number): void; max: number };
    title?: string;
    timing?: { aloneExitMs?: number; audioStallMs?: number; resourceSampleMs?: number };
    /** Stand-in for measuring the browser: returns the next figure, or throws. */
    usage?: () => Promise<{ processes: number; memMb: number; cores: number | null }>;
    fillers?: string[];
    /** How long the brain takes before it starts answering. */
    brainDelayMs?: number;
    /** Audio for these exact sentences is "already on disk" and costs nothing. */
    freeAudio?: string[];
  } = {},
) {
  const prompts: string[] = [];
  const synthesized: string[] = [];
  const sent: string[] = [];
  const questions: { id: number; asker: string; question: string }[] = [];
  const events: DashboardEvent[] = [];
  const chat: string[] = [];
  let onAudio: (pcm: Buffer) => void = () => {};

  const bot = Object.assign(new EventEmitter(), {
    join: vi.fn(async () => {}),
    play: vi.fn(async () => 0.1),
    stopSpeaking: vi.fn(async () => {}),
    queuedSeconds: vi.fn(async () => 0),
    ...(opts.usage ? { resourceUsage: opts.usage } : {}),
    setMuted: vi.fn(async () => {}),
    raiseHand: vi.fn(async () => {}),
    sendChat: vi.fn(async (text: string) => {
      chat.push(text);
      return true;
    }),
    leave: vi.fn(async () => {}),
  }) as unknown as BotLike &
    EventEmitter & {
      play: ReturnType<typeof vi.fn>;
      stopSpeaking: ReturnType<typeof vi.fn>;
      queuedSeconds: ReturnType<typeof vi.fn>;
    };

  const stt = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    secondsSent: 0,
    usesCaptions: false,
  }) as unknown as SttLike & EventEmitter & { stop: ReturnType<typeof vi.fn> };

  const captionStt = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    secondsSent: 0,
    usesCaptions: true,
    pushCaptions: vi.fn(),
  }) as unknown as SttLike & EventEmitter & { start: ReturnType<typeof vi.fn> };

  const llm: Llm = {
    async ask(prompt, onText) {
      prompts.push(prompt);
      const reply = replies.shift() ?? SILENT;
      if (opts.brainDelayMs) await new Promise((r) => setTimeout(r, opts.brainDelayMs));
      // Arrives in two parts, as it does from the real model: the decision, then the words.
      const cut = reply.indexOf('SAY:');
      if (cut > 0) {
        onText?.(reply.slice(0, cut));
        onText?.(reply.slice(cut));
      } else {
        onText?.(reply + '\n');
      }
      return reply;
    },
    close() {},
  };

  const meeting = store.createMeeting({
    link: 'https://teams.microsoft.com/l/meetup-join/test',
    title: opts.title ?? 'Weekly sync',
    update_text: 'The migration is done.',
    context: '',
    do_not_discuss: '',
    notify_mode: opts.notifyMode,
  });
  let ended = 0;

  const session = new MeetingSession(meeting, {
    createBot: async (cb) => {
      onAudio = cb;
      return bot;
    },
    createStt: () => stt,
    createCaptionStt: () => captionStt,
    ttsMaxChars: opts.ttsMaxChars ?? 100_000,
    createLlm: () => llm,
    synthesize: async (text, onChunk, o) => {
      synthesized.push(text);
      await onChunk(Buffer.alloc(480));
      if (opts.freeAudio?.includes(text)) return { free: true };
      if (opts.slowVoice) {
        // Keep "talking" until cut off.
        await new Promise<void>((_, reject) =>
          o.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
    },
    summarize: async () => 'SUMMARY: fine.',
    notifier: {
      send: async (text) => void sent.push(text),
      sendQuestion: async (id, asker, question) => void questions.push({ id, asker, question }),
    },
    broadcast: (e) => events.push(e),
    timing: { floorSilenceMs: 30, batchMs: 20, raiseHandAfterMs: 100, giveUpFloorAfterMs: 300, fillerAfterMs: 40, ...opts.timing },
    fillers: opts.fillers,
    greeting: () => 'Hi',
    voiceBudget: opts.voiceBudget,
    doNotDisturb: opts.doNotDisturb,
    onEnded: () => void ended++,
  });
  await session.run();

  const agentLines = () =>
    store
      .listUtterances(meeting.id)
      .filter((u) => u.is_agent)
      .map((u) => u.text);

  return { session, meeting, bot, stt, captionStt, prompts, synthesized, sent, questions, events, chat, agentLines, ended: () => ended, audio: (pcm: Buffer) => onAudio(pcm) };
}

describe('MeetingSession', () => {
  it('gives the update when asked, introducing itself as an AI the first time only', async () => {
    const h = await harness([
      'ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.',
      'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: It took three weeks.',
    ]);
    h.stt.emit('final', 'Sam, can we have your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(h.synthesized[0]).toBe(
      "Hi, this is Sam Rivera's AI assistant, speaking on Sam Rivera's behalf. The migration is done.",
    );
    expect(h.bot.play).toHaveBeenCalled();

    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(2));
    expect(h.synthesized[1]).toBe('It took three weeks.');
    expect(h.prompts[1]).toContain('update_delivered=yes');
    await h.session.stop('test over');
  });

  it('stays quiet during unrelated talk', async () => {
    const h = await harness([]);
    h.stt.emit('final', 'The design review moved to Thursday.');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.synthesized).toEqual([]);
    expect(h.agentLines()).toEqual([]);
    await h.session.stop('test over');
  });

  it('escalates an unknown question, then relays the owner\'s answer', async () => {
    const h = await harness([
      'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Alex\nQUESTION: Can Sam commit to Friday?\nSAY: I have asked Sam and will pass on the reply.',
    ]);
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    expect(h.questions[0]).toMatchObject({ asker: 'Alex', question: 'Can Sam commit to Friday?' });
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));

    h.session.relayAnswer(store.getQuestion(h.questions[0].id)!, 'Yes, Friday works.');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(2));
    // The question is read back first, so the room knows which one is being answered.
    expect(h.agentLines()[1]).toBe("Sam just got back to me. Alex asked: Can Sam commit to Friday? Sam's answer: Yes, Friday works.");
    expect(store.getQuestion(h.questions[0].id)!.status).toBe('relayed');
    await h.session.stop('test over');
  });

  it('stops talking when someone speaks over it and tells the brain', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], { slowVoice: true });
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.bot.play).toHaveBeenCalled());
    for (let i = 0; i < 6; i++) h.audio(loudFrame());
    await vi.waitFor(() => expect(h.bot.stopSpeaking).toHaveBeenCalled());

    h.stt.emit('final', 'Sorry, one more thing about the budget?');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    expect(h.prompts[1]).toMatch(/started talking/);
    expect(h.prompts[1]).toContain('update_delivered=no'); // the update was cut off, so it is still owed
    await h.session.stop('test over');
  });

  it('says nothing while muted but still escalates', async () => {
    const h = await harness([
      'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Dana\nQUESTION: What is the budget?\nSAY: I have asked Sam.',
    ]);
    await h.session.setMuted(true);
    h.stt.emit('final', 'Sam, what is the budget?');
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    expect(h.synthesized).toEqual([]);
    await h.session.stop('test over');
  });

  it('posts in chat when it cannot get a gap to speak', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.']);
    // Someone talks continuously, so there is never a gap.
    for (let i = 0; i < 6; i++) h.audio(loudFrame());
    const talking = setInterval(() => h.audio(loudFrame()), 20);
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.chat).toHaveLength(1), { timeout: 3000 });
    clearInterval(talking);
    expect(h.chat[0]).toContain('The migration is done.');
    expect(h.synthesized).toEqual([]);
    await h.session.stop('test over');
  });

  it('stops using the paid voice once the per-meeting character limit is reached', async () => {
    const h = await harness(
      [
        'ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.',
        'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: It took three weeks to finish.',
      ],
      { ttsMaxChars: 120 },
    );
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(h.synthesized).toHaveLength(1); // intro + update fits in the budget

    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.chat).toHaveLength(1));
    expect(h.chat[0]).toContain('It took three weeks to finish.');
    expect(h.synthesized).toHaveLength(1); // nothing more was sent to the voice
    expect(h.sent.some((m) => m.includes('voice limit'))).toBe(true);
    await h.session.stop('test over');
  });

  it('switches to free captions when paid transcription hits its limit', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.']);
    h.stt.emit('limit');
    expect(h.stt.stop).toHaveBeenCalled();
    expect(h.captionStt.start).toHaveBeenCalled();

    // The meeting carries on from captions, which also supply the speaker.
    h.captionStt.emit('final', 'Sam, your update?', 'Alex Morgan');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(store.listUtterances(h.meeting.id)[0]).toMatchObject({ speaker: 'Alex Morgan', text: 'Sam, your update?' });
    await h.session.stop('test over');
  });

  it('sends the summary and open questions when the meeting ends', async () => {
    const h = await harness([
      'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Alex\nQUESTION: Can Sam commit to Friday?\nSAY: I have asked Sam.',
    ]);
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    h.bot.emit('ended', 'The meeting ended');
    await vi.waitFor(() => expect(store.getMeeting(h.meeting.id)!.status).toBe('ended'));
    await vi.waitFor(() => expect(h.sent.at(-1)).toContain('SUMMARY: fine.'));
    expect(h.sent.at(-1)).toContain('Can Sam commit to Friday?');
    expect(store.getMeeting(h.meeting.id)!.summary).toBe('SUMMARY: fine.');
  });
});

describe('several meetings at once', () => {
  const ESCALATE = 'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Alex\nQUESTION: Can Sam commit to Friday?\nSAY: Sam will follow up.';

  it('keeps two running meetings completely separate', async () => {
    const a = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: Standup answer.'], { title: 'Standup' });
    const b = await harness([ESCALATE], { title: 'Design review' });
    a.stt.emit('final', 'Sam, your update?');
    b.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(a.agentLines()).toHaveLength(1));
    await vi.waitFor(() => expect(b.questions).toHaveLength(1));

    expect(a.agentLines()[0]).toContain('Standup answer.');
    expect(a.questions).toHaveLength(0);
    expect(store.listQuestions(a.meeting.id)).toHaveLength(0);
    expect(store.listQuestions(b.meeting.id)[0].question).toBe('Can Sam commit to Friday?');
    expect(store.listUtterances(a.meeting.id).some((u) => u.text.includes('Friday'))).toBe(false);
    expect(a.sent.every((m) => !m.includes('Design review'))).toBe(true);

    // Ending one leaves the other running.
    await a.session.stop('test over');
    expect(a.ended()).toBe(1);
    expect(a.session.active).toBe(false);
    expect(b.session.active).toBe(true);
    await b.session.stop('test over');
  });

  it('holds questions for the summary when asked not to disturb', async () => {
    const h = await harness([ESCALATE], { notifyMode: 'collect' });
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(store.listQuestions(h.meeting.id)).toHaveLength(1));
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    // No live ping, and the brain was told to promise a follow-up rather than a reply.
    expect(h.questions).toHaveLength(0);
    expect(h.prompts[0]).toContain('cannot be reached during this meeting');
    await h.session.stop('test over');
    await vi.waitFor(() => expect(h.sent.at(-1)).toContain('Can Sam commit to Friday?'));
  });

  it('holds questions while do-not-disturb is switched on, and asks live again after', async () => {
    let dnd = true;
    const h = await harness([ESCALATE, ESCALATE.replace('Friday', 'Monday')], { doNotDisturb: () => dnd });
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(store.listQuestions(h.meeting.id)).toHaveLength(1));
    expect(h.questions).toHaveLength(0);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));

    dnd = false;
    h.stt.emit('final', 'Or Monday, Sam?');
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    expect(h.questions[0].question).toContain('Monday');
    await h.session.stop('test over');
  });

  it('moves to chat when the shared daily voice allowance runs out', async () => {
    let spent = 0;
    const budget = { max: 100, canSpend: (n: number) => spent + n <= 100, spend: (n: number) => void (spent += n) };
    const h = await harness(
      [
        'ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: Done.',
        'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: It took three weeks to finish.',
      ],
      { voiceBudget: budget },
    );
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(spent).toBeGreaterThan(0);
    spent = 100; // another meeting used the rest

    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.chat).toHaveLength(1));
    expect(h.synthesized).toHaveLength(1);
    expect(h.sent.some((m) => m.includes("Today's voice limit across all meetings"))).toBe(true);
    await h.session.stop('test over');
  });

  it('closes a question the owner will answer later and tells the room', async () => {
    const h = await harness([ESCALATE]);
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    h.session.followUpLater(store.getQuestion(h.questions[0].id)!);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(2));
    expect(h.agentLines()[1]).toContain('will follow up after the meeting');
    expect(h.session.pendingQuestions).toHaveLength(0);
    await h.session.stop('test over');
  });
});

describe('measuring the browser', () => {
  it('keeps the latest figures and saves the peak and average when the meeting ends', async () => {
    const figures = [
      { processes: 8, memMb: 500, cores: null },
      { processes: 9, memMb: 700, cores: 0.5 },
      { processes: 9, memMb: 600, cores: 0.7 },
    ];
    let i = 0;
    const h = await harness([], {
      timing: { resourceSampleMs: 30 },
      usage: async () => figures[Math.min(i++, figures.length - 1)],
    });
    await vi.waitFor(() => expect(i).toBeGreaterThanOrEqual(3));
    expect(h.session.resourceNow?.processes).toBe(9);
    // Stop exactly after the third figure so the totals are known.
    i = 99;
    await h.session.stop('test over');
    const m = store.getMeeting(h.meeting.id)!;
    expect(m.ram_peak_mb).toBe(700);
    expect(m.ram_avg_mb).toBeGreaterThan(500);
    expect(m.ram_avg_mb).toBeLessThanOrEqual(700);
    expect(m.cpu_avg).toBeGreaterThan(0.4);
  });

  it('carries on normally when measuring fails', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], {
      timing: { resourceSampleMs: 20 },
      usage: async () => {
        throw new Error('no such process');
      },
    });
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    await h.session.stop('test over');
    expect(store.getMeeting(h.meeting.id)!.ram_peak_mb).toBeNull();
  });
});

describe('audio that is not reaching the meeting', () => {
  it('notices speech that never plays, tells the owner, and uses the chat from then on', async () => {
    const h = await harness(
      [
        'ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.',
        'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: It took three weeks to finish.',
      ],
      { timing: { audioStallMs: 150 } },
    );
    // The browser accepts the audio but its clock is stopped: the queue never empties.
    h.bot.queuedSeconds.mockResolvedValue(4);
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.chat).toHaveLength(1), { timeout: 3000 });
    expect(h.chat[0]).toContain('The migration is done.');
    expect(h.bot.stopSpeaking).toHaveBeenCalled();
    expect(h.sent.some((m) => m.includes('voice is not reaching'))).toBe(true);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));

    // The next reply goes straight to chat without paying for audio nobody hears.
    const paid = h.synthesized.length;
    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.chat).toHaveLength(2));
    expect(h.chat[1]).toContain('It took three weeks to finish.');
    expect(h.synthesized).toHaveLength(paid);
    await h.session.stop('test over');
  });
});

describe('everyone else has left', () => {
  const quick = { timing: { aloneExitMs: 60 } };

  it('leaves soon after the last other person goes, and sends the summary', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], quick);
    h.bot.emit('participants', 3);
    h.stt.emit('final', 'Sam, your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));

    h.bot.emit('participants', 1);
    expect(h.session.active).toBe(true); // not instantly: a brief blip must not end the meeting
    // Teams is polled several times a second; keep reporting "1" as it would.
    const poll = setInterval(() => h.bot.emit('participants', 1), 20);
    await vi.waitFor(() => expect(store.getMeeting(h.meeting.id)!.status).toBe('ended'));
    clearInterval(poll);
    expect(h.bot.leave).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.sent.at(-1)).toContain('everyone else left the meeting'));
    expect(store.getMeeting(h.meeting.id)!.end_reason).toBe('everyone else left the meeting');
  });

  it('does not treat words without detected sound as ten minutes of silence', async () => {
    // A quiet speaker: captions arrive but the speech detector never fires.
    // This used to end the meeting on the next tick with "nobody spoke for 10 minutes".
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], { brainDelayMs: 1200 });
    h.stt.emit('final', 'Can we have your update?');
    await new Promise((r) => setTimeout(r, 1150)); // past the once-a-second idle check
    expect(h.session.active).toBe(true);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1), { timeout: 3000 });
    expect(h.agentLines()[0]).toContain('The migration is done.');
    await h.session.stop('test over');
  });

  it('stays if someone comes back in time', async () => {
    const h = await harness([], quick);
    h.bot.emit('participants', 2);
    h.bot.emit('participants', 1);
    h.bot.emit('participants', 2);
    await new Promise((r) => setTimeout(r, 90));
    h.bot.emit('participants', 2);
    expect(h.session.active).toBe(true);
    await h.session.stop('test over');
  });

  it('does not leave for being the first to arrive', async () => {
    const h = await harness([], quick);
    h.bot.emit('participants', 1);
    await new Promise((r) => setTimeout(r, 90));
    h.bot.emit('participants', 1);
    h.bot.emit('participants', 0);
    expect(h.session.active).toBe(true);
    await h.session.stop('test over');
  });

  it('never leaves because the number is missing', async () => {
    const h = await harness([], quick);
    h.bot.emit('participants', 2);
    h.bot.emit('participants', 0);
    await new Promise((r) => setTimeout(r, 90));
    h.bot.emit('participants', 0);
    expect(h.session.active).toBe(true);
    await h.session.stop('test over');
  });

  it('never leaves on a count of one that was never higher, even after people have spoken', async () => {
    // What a misread number looks like: stuck at 1 while someone is plainly there.
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], quick);
    h.bot.emit('participants', 1);
    h.stt.emit('final', 'Can we have your update?');
    await new Promise((r) => setTimeout(r, 90));
    h.bot.emit('participants', 1);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    h.bot.emit('participants', 1);
    expect(h.session.active).toBe(true);
    await h.session.stop('test over');
  });

  it('does not leave while someone is still being heard, whatever the number says', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.'], quick);
    h.bot.emit('participants', 2);
    h.bot.emit('participants', 1);
    await new Promise((r) => setTimeout(r, 45));
    // Most of the wait has passed when a question arrives: the room is not empty,
    // so the wait starts again instead of running out.
    h.stt.emit('final', 'Can we have your update?');
    h.bot.emit('participants', 1);
    await new Promise((r) => setTimeout(r, 30));
    h.bot.emit('participants', 1);
    expect(h.session.active).toBe(true);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(store.getMeeting(h.meeting.id)!.status).toBe('live');
    await h.session.stop('test over');
    expect(store.getMeeting(h.meeting.id)!.end_reason).toBe('test over');
  });
});

describe('asked to leave', () => {
  const LEAVE = 'ACTION: leave\nDELIVERS_UPDATE: no\nSAY: Thanks everyone, goodbye.';

  it('says goodbye, really leaves, and sends the summary with open questions', async () => {
    const h = await harness([
      'ACTION: escalate\nDELIVERS_UPDATE: no\nASKER: Alex\nQUESTION: Can Sam commit to Friday?\nSAY: I have asked Sam.',
      LEAVE,
    ]);
    h.stt.emit('final', 'Sam, can you commit to Friday?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));

    h.stt.emit('final', 'Okay assistant, you can leave the meeting now.');
    await vi.waitFor(() => expect(store.getMeeting(h.meeting.id)!.status).toBe('ended'));
    expect(h.agentLines().at(-1)).toBe('Thanks everyone, goodbye.');
    expect(h.bot.leave).toHaveBeenCalled();
    expect(h.session.active).toBe(false);
    expect(h.ended()).toBe(1);
    await vi.waitFor(() => expect(h.sent.at(-1)).toContain('SUMMARY: fine.'));
    expect(h.sent.at(-1)).toContain('asked the assistant to leave');
    expect(h.sent.at(-1)).toContain('Can Sam commit to Friday?');
  });

  it('leaves without a word when muted', async () => {
    const h = await harness([LEAVE]);
    await h.session.setMuted(true);
    h.stt.emit('final', 'Assistant, you can leave now.');
    await vi.waitFor(() => expect(store.getMeeting(h.meeting.id)!.status).toBe('ended'));
    expect(h.agentLines()).toHaveLength(0);
    expect(h.synthesized).toEqual([]);
  });

  it('stays when the brain does not choose to leave', async () => {
    const h = await harness([SILENT]);
    h.stt.emit('final', 'Bye Priya, see you tomorrow.');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.session.active).toBe(true);
    await h.session.stop('test over');
  });
});

describe('thinking out loud', () => {
  const UPDATE = 'ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.';
  const ANSWER = 'ACTION: speak\nDELIVERS_UPDATE: no\nSAY: It took three weeks to finish.';

  it('says a filler when a direct question takes a moment, but not before the introduction', async () => {
    const h = await harness([UPDATE, ANSWER], { fillers: ['Hmm, let me check.'], brainDelayMs: 150, freeAudio: ['Hmm, let me check.'] });
    h.stt.emit('final', 'Sam, can we have your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    // First time speaking: the introduction comes first and no filler is added.
    expect(h.agentLines()[0]).toBe("Hi, this is Sam Rivera's AI assistant, speaking on Sam Rivera's behalf. The migration is done.");

    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(2));
    expect(h.agentLines()[1]).toBe('Hmm, let me check. It took three weeks to finish.');
    await h.session.stop('test over');
    // The filler came from the cache, so only the real sentences were charged.
    const charged = h.agentLines()[0].length + 'It took three weeks to finish.'.length;
    expect(store.getMeeting(h.meeting.id)!.tts_chars).toBe(charged);
  });

  it('says no filler when the answer is quick', async () => {
    const h = await harness([UPDATE, ANSWER], { fillers: ['Hmm, let me check.'] });
    h.stt.emit('final', 'Sam, can we have your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    h.stt.emit('final', 'How long did it take, Sam?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(2));
    expect(h.agentLines()[1]).toBe('It took three weeks to finish.');
    await h.session.stop('test over');
  });

  it('says no filler for talk that is not a direct question', async () => {
    const h = await harness([UPDATE, SILENT], { fillers: ['Hmm, let me check.'], brainDelayMs: 150 });
    h.stt.emit('final', 'Sam, can we have your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    h.stt.emit('final', 'The weather is terrible today.');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.agentLines()).toHaveLength(1);
    await h.session.stop('test over');
  });
});

describe('rehearsal', () => {
  it('answers a typed line without any audio', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.']);
    h.session.hear('Alex', 'Sam, can we have your update?');
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    const lines = store.listUtterances(h.meeting.id);
    expect(lines[0]).toMatchObject({ speaker: 'Alex', text: 'Sam, can we have your update?' });
    expect(h.agentLines()[0]).toContain('The migration is done.');
    await h.session.stop('test over');
  });

  it('offers the update in a simulated quiet room, once', async () => {
    const h = await harness(['ACTION: speak\nDELIVERS_UPDATE: yes\nSAY: The migration is done.']);
    expect(h.session.simulateLull()).toBe(true);
    await vi.waitFor(() => expect(h.agentLines()).toHaveLength(1));
    expect(h.prompts[0]).toMatch(/quiet|silen/i);
    // The update has been given, so another silence is nothing to act on.
    expect(h.session.simulateLull()).toBe(false);
    await h.session.stop('test over');
  });
});
