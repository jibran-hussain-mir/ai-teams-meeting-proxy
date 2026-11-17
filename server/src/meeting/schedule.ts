import { config } from '../config.js';
import { fromDbTime, type Meeting } from '../db.js';

/** Tell the owner this long before a scheduled join. */
export const REMIND_MS = config.scheduleRemindMs;
/** Still join if the start time passed no longer ago than this (e.g. the app was restarted). */
export const LATE_MS = config.scheduleLateMs;

export type ScheduleAction =
  | { do: 'wait' }
  | { do: 'remind'; minutes: number }
  | { do: 'start' }
  | { do: 'fail'; reason: string };

/** What to do about one scheduled meeting right now. */
export function scheduleAction(
  meeting: Meeting,
  now: number,
  state: { busy: boolean; missing: string[]; reminded: boolean },
): ScheduleAction {
  const at = fromDbTime(meeting.scheduled_at ?? '').getTime();
  if (Number.isNaN(at)) return { do: 'fail', reason: 'The scheduled time could not be read' };
  const wait = at - now;
  if (wait > 0) {
    return wait <= REMIND_MS && !state.reminded ? { do: 'remind', minutes: Math.max(1, Math.round(wait / 60_000)) } : { do: 'wait' };
  }
  if (-wait > LATE_MS) {
    return {
      do: 'fail',
      reason: state.busy
        ? 'Every meeting slot was still in use at the scheduled time'
        : 'The app was not running at the scheduled time',
    };
  }
  if (state.missing.length) return { do: 'fail', reason: `Setup is incomplete: ${state.missing.join(', ')}` };
  // No free place yet: keep trying until one opens or the meeting is too late to join.
  if (state.busy) return { do: 'wait' };
  return { do: 'start' };
}
