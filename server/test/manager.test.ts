import { describe, expect, it } from 'vitest';
import { store, type Meeting, type MeetingKind } from '../src/db.js';
import { ManagerError, MeetingManager, meetingTag } from '../src/meeting/manager.js';
import type { MeetingSession } from '../src/meeting/session.js';

/** A session that does nothing but stay "in the meeting" until stopped. */
function fakeSession(onEnded: () => void) {
  const s = {
    active: true,
    ran: false,
    async run() {
      s.ran = true;
    },
    async stop() {
      s.active = false;
      onEnded();
    },
  };
  return s;
}

function setup(max = 2) {
  const sessions = new Map<number, ReturnType<typeof fakeSession>>();
  const manager = new MeetingManager({
    max: () => max,
    create(meeting, _slot, onEnded) {
      const s = fakeSession(onEnded);
      sessions.set(meeting.id, s);
      return s as unknown as MeetingSession;
    },
  });
  let n = 0;
  const meeting = (kind: MeetingKind = 'teams', link?: string): Meeting =>
    store.createMeeting({
      link: kind === 'teams' ? (link ?? `https://teams.microsoft.com/l/meetup-join/${++n}`) : '',
      title: `Meeting ${++n}`,
      update_text: '',
      context: '',
      do_not_discuss: '',
      kind,
    });
  return { manager, sessions, meeting };
}

describe('MeetingManager', () => {
  it('runs several meetings at once, each with its own colour', () => {
    const { manager, sessions, meeting } = setup(3);
    const a = manager.start(meeting());
    const b = manager.start(meeting());
    expect(manager.live().map((r) => r.meetingId)).toEqual([a.meetingId, b.meetingId]);
    expect([a.slot, b.slot]).toEqual([0, 1]);
    expect(a.tag.startsWith('🟦')).toBe(true);
    expect(b.tag.startsWith('🟩')).toBe(true);
    expect(sessions.get(a.meetingId)!.ran).toBe(true);
    expect(manager.get(b.meetingId)?.session).toBe(sessions.get(b.meetingId));
  });

  it('refuses a meeting beyond the limit and takes one again when a place frees up', async () => {
    const { manager, meeting } = setup(2);
    const a = manager.start(meeting());
    manager.start(meeting());
    const third = meeting();
    expect(manager.blocked(third)).toMatch(/limit/);
    expect(() => manager.start(third)).toThrow(ManagerError);

    await a.session.stop('done');
    expect(manager.get(a.meetingId)).toBeUndefined();
    expect(manager.blocked(third)).toBeNull();
    // The freed colour is reused, so colours stay few and stable.
    expect(manager.start(third).slot).toBe(0);
  });

  it('will not join the same meeting twice', () => {
    const { manager, meeting } = setup(3);
    manager.start(meeting('teams', 'https://teams.microsoft.com/l/meetup-join/same'));
    expect(manager.blocked(meeting('teams', 'https://teams.microsoft.com/l/meetup-join/same'))).toMatch(/already in that meeting/);
  });

  it('does not let rehearsals use up places for real meetings', () => {
    const { manager, meeting } = setup(1);
    manager.start(meeting('rehearsal'));
    expect(manager.blocked(meeting('teams'))).toBeNull();
    expect(manager.blocked(meeting('rehearsal'))).toMatch(/rehearsal/);
    expect(meetingTag(0, 'rehearsal', 'Practice')).toBe('🧪 Practice');
  });

  it('stops everything on shutdown', async () => {
    const { manager, meeting } = setup(3);
    manager.start(meeting());
    manager.start(meeting());
    await manager.stopAll('shutting down');
    expect(manager.live()).toHaveLength(0);
  });
});
