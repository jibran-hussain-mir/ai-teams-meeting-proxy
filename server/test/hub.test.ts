import { describe, expect, it } from 'vitest';
import { store } from '../src/db.js';
import { TelegramHub, type HubControl, type LiveInfo, type Outgoing, type Transport } from '../src/notify/hub.js';

/** Telegram replaced by a recorder, and the app by a scripted set of running meetings. */
function setup(meetingCount = 2) {
  const sent: (Outgoing & { id: number })[] = [];
  const edits: (Outgoing & { id: number })[] = [];
  let nextId = 100;
  const transport: Transport = {
    enabled: true,
    async send(msg) {
      const id = nextId++;
      sent.push({ ...msg, id });
      return [id];
    },
    async edit(id, msg) {
      edits.push({ ...msg, id });
    },
  };

  const colours = ['🟦', '🟩', '🟧'];
  const names = ['Standup', 'Design review', 'Retro'];
  const live: LiveInfo[] = [];
  for (let i = 0; i < meetingCount; i++) {
    const m = store.createMeeting({ link: `https://teams.microsoft.com/x/${i}`, title: names[i], update_text: '', context: '', do_not_discuss: '' });
    live.push({ id: m.id, tag: `${colours[i]} ${names[i]}`, phase: 'live', agent: 'listening', muted: false, pending: 0, startedAt: Date.now() - 12 * 60_000 });
  }

  const calls: string[] = [];
  const control: HubControl = {
    live: () => live,
    upcoming: () => [],
    pending: () =>
      live.flatMap((m) =>
        store
          .listQuestions(m.id)
          .filter((q) => q.status === 'pending')
          .map((q) => ({ id: q.id, meetingId: q.meeting_id, asker: q.asker, question: q.question })),
      ),
    say(id, text) {
      calls.push(`say ${id}: ${text}`);
      return 'Will say it at the next gap.';
    },
    async mute(id, muted) {
      calls.push(`${muted ? 'mute' : 'unmute'} ${id}`);
      live.find((m) => m.id === id)!.muted = muted;
      return muted ? 'Muted.' : 'Unmuted.';
    },
    leave(id) {
      calls.push(`leave ${id}`);
      return 'Leaving.';
    },
    answer(questionId, text) {
      calls.push(`answer ${questionId}: ${text}`);
      store.answerQuestion(questionId, text, 'relayed');
      return 'Got it.';
    },
    followUp(questionId) {
      calls.push(`later ${questionId}`);
      return 'Okay.';
    },
    async catchUp(id) {
      calls.push(`catch ${id}`);
      return 'They are discussing the release date.';
    },
  };

  const hub = new TelegramHub(transport, control);
  const notifiers = live.map((m) => hub.forMeeting(m.id, m.tag));
  const data = (msg: Outgoing, label: string) => msg.buttons!.flat().find((b) => b.text.includes(label))!.data;
  return { hub, live, sent, edits, calls, notifiers, data };
}

describe('TelegramHub with several meetings', () => {
  it('labels every message with its meeting', async () => {
    const h = setup();
    await h.notifiers[0].send('The voice limit is used up.');
    await h.notifiers[1].send('Someone left.');
    expect(h.sent[0].text).toBe('🟦 Standup\nThe voice limit is used up.');
    expect(h.sent[1].text.startsWith('🟩 Design review\n')).toBe(true);
  });

  it('sends a reply to a question to the meeting it came from, whichever is replied to', async () => {
    const h = setup();
    const q1 = store.addQuestion(h.live[0].id, 'Priya', 'What is the budget?');
    const q2 = store.addQuestion(h.live[1].id, 'Alex', 'When is the release?');
    await h.notifiers[0].sendQuestion(q1.id, q1.asker, q1.question);
    await h.notifiers[1].sendQuestion(q2.id, q2.asker, q2.question);
    expect(h.sent[0].text).toContain('🟦 Standup · Question from Priya');
    expect(h.sent[0].buttons!.flat().map((b) => b.text)).toEqual(["I'll follow up later", 'Catch me up']);

    // Answer the second meeting's question by replying to its message.
    const reply = await h.hub.text('Next Friday.', h.sent[1].id);
    expect(h.calls).toEqual([`answer ${q2.id}: Next Friday.`]);
    expect(reply.text).toBe('🟩 Design review · Got it.');
  });

  it('asks which question an unaddressed answer belongs to', async () => {
    const h = setup();
    const q1 = store.addQuestion(h.live[0].id, 'Priya', 'What is the budget?');
    store.addQuestion(h.live[1].id, 'Alex', 'When is the release?');
    const ask = await h.hub.text('About forty thousand.');
    expect(h.calls).toEqual([]);
    expect(ask.text).toContain('Which question');
    const result = await h.hub.button(h.data(ask, 'Priya'));
    expect(h.calls).toEqual([`answer ${q1.id}: About forty thousand.`]);
    expect(result.replace).toBe(true);
  });

  it('answers the only open question without asking', async () => {
    const h = setup();
    const q = store.addQuestion(h.live[1].id, 'Alex', 'When is the release?');
    await h.hub.text('Next Friday.');
    expect(h.calls).toEqual([`answer ${q.id}: Next Friday.`]);
  });

  it('confirms before speaking when the reply is not to a question', async () => {
    const h = setup();
    await h.notifiers[1].send('Joined.');
    const ask = await h.hub.text('Please wait for me.', h.sent[0].id);
    expect(ask.text).toBe('Say "Please wait for me." in 🟩 Design review?');
    expect(h.calls).toEqual([]);
    const result = await h.hub.button(h.data(ask, 'Say it'));
    expect(h.calls).toEqual([`say ${h.live[1].id}: Please wait for me.`]);
    expect(result.text).toBe('🟩 Design review · Will say it at the next gap.');
    // The held text is used once: pressing an old button again does nothing.
    expect((await h.hub.button(h.data(ask, 'Say it'))).text).toMatch(/expired/);
  });

  it('asks which meeting for /say, and can say it in all of them', async () => {
    const h = setup();
    const ask = await h.hub.command('say', 'Running five minutes late');
    expect(ask.text).toBe('Say "Running five minutes late" in which meeting?');
    expect(ask.buttons!.flat().map((b) => b.text)).toEqual(['🟦 Standup', '🟩 Design review', 'All meetings', 'Cancel']);
    await h.hub.button(h.data(ask, 'All meetings'));
    expect(h.calls).toEqual(h.live.map((m) => `say ${m.id}: Running five minutes late`));
  });

  it('acts at once when only one meeting is running', async () => {
    const h = setup(1);
    expect((await h.hub.command('say', 'Hello')).text).toBe('🟦 Standup · Will say it at the next gap.');
    expect((await h.hub.command('mute')).text).toBe('🟦 Standup · Muted.');
    expect((await h.hub.command('catchup')).text).toBe('🟦 Standup · Catch-up\n\nThey are discussing the release date.');
    expect(h.calls).toEqual([`say ${h.live[0].id}: Hello`, `mute ${h.live[0].id}`, `catch ${h.live[0].id}`]);
  });

  it('lets a chosen meeting be muted or left, and cancel does nothing', async () => {
    const h = setup();
    const ask = await h.hub.command('leave');
    expect(ask.text).toBe('Leave which meeting?');
    expect((await h.hub.button(h.data(ask, 'Cancel'))).text).toBe('Cancelled.');
    await h.hub.button(h.data(ask, 'Design review'));
    expect(h.calls).toEqual([`leave ${h.live[1].id}`]);
  });

  it('keeps one status card per meeting and updates it in place', async () => {
    const h = setup();
    await h.notifiers[0].status!('lobby', 'Waiting to be admitted.');
    await h.notifiers[0].status!('live', 'Joined Standup.');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('In the lobby');
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0].id).toBe(h.sent[0].id);
    expect(h.edits[0].text).toMatch(/🟦 Standup\nLive since .* · listening\nJoined Standup\./);
    expect(h.edits[0].buttons!.flat().map((b) => b.text)).toEqual(['Mute', 'Catch me up', 'Leave']);

    // Muting from the card flips its button.
    const result = await h.hub.button(h.data(h.edits[0], 'Mute'));
    expect(result.replace).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.edits.at(-1)!.buttons!.flat()[0].text).toBe('Unmute');

    await h.notifiers[0].status!('ended', 'Standup has ended.');
    expect(h.edits.at(-1)!.text).toContain('Ended');
    expect(h.edits.at(-1)!.buttons).toBeUndefined();
    expect(h.sent).toHaveLength(1);
  });

  it('lists everything running in one overview', async () => {
    const h = setup();
    store.addQuestion(h.live[0].id, 'Priya', 'What is the budget?');
    h.live[0].pending = 1;
    h.live[1].phase = 'lobby';
    const out = await h.hub.command('meetings');
    expect(out.text).toContain('2 meetings running');
    expect(out.text).toContain('🟦 Standup — live 12 min, listening, 1 open question');
    expect(out.text).toContain('🟩 Design review — waiting in the lobby');
    expect(out.buttons).toHaveLength(2);
  });

  it('passes "follow up later" to the right question and toggles do-not-disturb', async () => {
    const h = setup();
    const q = store.addQuestion(h.live[0].id, 'Priya', 'What is the budget?');
    await h.notifiers[0].sendQuestion(q.id, q.asker, q.question);
    const result = await h.hub.button(h.data(h.sent[0], 'follow up later'));
    expect(h.calls).toEqual([`later ${q.id}`]);
    expect(result.text).toBe('🟦 Standup · Okay.');

    expect(h.hub.dnd).toBe(false);
    expect((await h.hub.command('dnd', 'on')).text).toMatch(/is on/);
    expect(h.hub.dnd).toBe(true);
    await h.hub.command('dnd', 'off');
    expect(h.hub.dnd).toBe(false);
  });

  it('says so when nothing is running', async () => {
    const h = setup(0);
    expect((await h.hub.command('say', 'Hello')).text).toMatch(/No meeting is running/);
    expect((await h.hub.text('Hello')).text).toMatch(/No meeting is running/);
    expect((await h.hub.command('meetings')).text).toBe('No meeting is running.');
  });
});
