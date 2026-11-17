import type { Meeting, MeetingKind } from '../db.js';
import type { MeetingSession } from './session.js';

/** One colour per simultaneous meeting, so each is recognisable at a glance in Telegram and the web app. */
export const SLOT_EMOJI = ['🟦', '🟩', '🟧', '🟪', '🟥', '🟨'];

/** How a meeting is labelled in messages, e.g. "🟦 Standup". */
export function meetingTag(slot: number, kind: MeetingKind, title: string): string {
  return `${kind === 'rehearsal' ? '🧪' : SLOT_EMOJI[slot % SLOT_EMOJI.length]} ${title || 'Meeting'}`;
}

export interface Running {
  session: MeetingSession;
  meetingId: number;
  kind: MeetingKind;
  link: string;
  title: string;
  /** Position among the simultaneous meetings (0, 1, 2…); decides the colour. */
  slot: number;
  tag: string;
  startedAt: number;
}

/** Thrown when a meeting cannot be started; the message is safe to show the owner. */
export class ManagerError extends Error {}

export interface ManagerOptions {
  /** Real meetings allowed at once. Rehearsals are counted separately against the same number. */
  max: () => number;
  /** Build the session for a meeting. `onEnded` must be called when the assistant has left. */
  create(meeting: Meeting, slot: number, onEnded: () => void): MeetingSession;
}

/** Runs several meetings side by side. Each MeetingSession is independent; this keeps track of them. */
export class MeetingManager {
  private readonly running = new Map<number, Running>();

  constructor(private readonly opts: ManagerOptions) {}

  /** Meetings in progress, oldest first. */
  live(): Running[] {
    return [...this.running.values()].filter((r) => r.session.active).sort((a, b) => a.startedAt - b.startedAt);
  }

  get(meetingId: number): Running | undefined {
    const r = this.running.get(meetingId);
    return r?.session.active ? r : undefined;
  }

  count(kind: MeetingKind): number {
    return this.live().filter((r) => r.kind === kind).length;
  }

  hasRoom(kind: MeetingKind): boolean {
    return this.count(kind) < this.opts.max();
  }

  /** Why this meeting cannot start now, or null if it can. */
  blocked(meeting: Pick<Meeting, 'kind' | 'link'>): string | null {
    if (meeting.kind === 'teams' && this.live().some((r) => r.kind === 'teams' && r.link === meeting.link)) {
      return 'The assistant is already in that meeting.';
    }
    if (!this.hasRoom(meeting.kind)) {
      const max = this.opts.max();
      return meeting.kind === 'rehearsal'
        ? `There are already ${max} rehearsals running. End one first.`
        : `The assistant is already in ${max} meeting${max === 1 ? '' : 's'}, which is the limit (MAX_MEETINGS). Leave one first.`;
    }
    return null;
  }

  private freeSlot(): number {
    const taken = new Set(this.live().map((r) => r.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    return slot;
  }

  /** Start the assistant on a meeting. The session runs in the background. */
  start(meeting: Meeting): Running {
    const reason = this.blocked(meeting);
    if (reason) throw new ManagerError(reason);
    const slot = this.freeSlot();
    const session = this.opts.create(meeting, slot, () => {
      if (this.running.get(meeting.id)?.session === session) this.running.delete(meeting.id);
    });
    const entry: Running = {
      session,
      meetingId: meeting.id,
      kind: meeting.kind,
      link: meeting.link,
      title: meeting.title,
      slot,
      tag: meetingTag(slot, meeting.kind, meeting.title),
      startedAt: Date.now(),
    };
    this.running.set(meeting.id, entry);
    void session.run();
    return entry;
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all(this.live().map((r) => r.session.stop(reason)));
  }
}
