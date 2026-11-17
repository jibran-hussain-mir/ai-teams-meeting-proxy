import { describe, expect, it } from 'vitest';
import { fromDbTime, store, toDbTime } from '../src/db.js';
import { LATE_MS, scheduleAction } from '../src/meeting/schedule.js';

const idle = { busy: false, missing: [] as string[], reminded: false };

function scheduledAt(at: Date) {
  return store.createMeeting({
    link: 'https://teams.microsoft.com/l/meetup-join/test',
    title: 'Standup',
    update_text: '',
    context: '',
    do_not_discuss: '',
    scheduled_at: toDbTime(at),
  });
}

describe('scheduled meetings', () => {
  const at = new Date('2026-11-20T09:30:00Z');
  const t = at.getTime();

  it('are stored as scheduled, in UTC, and listed until they start', () => {
    const m = scheduledAt(at);
    expect(m.status).toBe('scheduled');
    expect(m.kind).toBe('teams');
    expect(fromDbTime(m.scheduled_at!).getTime()).toBe(t);
    expect(store.listScheduled().map((x) => x.id)).toContain(m.id);
    store.markStarted(m.id);
    expect(store.getMeeting(m.id)!.status).toBe('starting');
    expect(store.listScheduled().map((x) => x.id)).not.toContain(m.id);
  });

  it('wait, then remind once, then start', () => {
    const m = scheduledAt(at);
    expect(scheduleAction(m, t - 60 * 60_000, idle)).toEqual({ do: 'wait' });
    expect(scheduleAction(m, t - 4 * 60_000, idle)).toEqual({ do: 'remind', minutes: 4 });
    expect(scheduleAction(m, t - 4 * 60_000, { ...idle, reminded: true })).toEqual({ do: 'wait' });
    expect(scheduleAction(m, t, idle)).toEqual({ do: 'start' });
    expect(scheduleAction(m, t + 60_000, idle)).toEqual({ do: 'start' });
    store.deleteMeeting(m.id);
    expect(store.getMeeting(m.id)).toBeUndefined();
  });

  it('wait for a free place when every slot is in use, then give up once too late', () => {
    const m = scheduledAt(at);
    const busy = { ...idle, busy: true };
    expect(scheduleAction(m, t, busy)).toEqual({ do: 'wait' });
    expect(scheduleAction(m, t + 5 * 60_000, busy)).toEqual({ do: 'wait' });
    // A place opened up five minutes late: still join.
    expect(scheduleAction(m, t + 5 * 60_000, idle)).toEqual({ do: 'start' });
    expect(scheduleAction(m, t + LATE_MS + 1000, busy)).toMatchObject({ do: 'fail', reason: expect.stringMatching(/slot/) });
    store.deleteMeeting(m.id);
  });

  it('are given up on when missed or not set up', () => {
    const m = scheduledAt(at);
    expect(scheduleAction(m, t + LATE_MS + 1000, idle)).toMatchObject({ do: 'fail', reason: expect.stringMatching(/not running/) });
    expect(scheduleAction(m, t, { ...idle, missing: ['ELEVENLABS_VOICE_ID'] }).do).toBe('fail');
    store.deleteMeeting(m.id);
  });
});
