import { EventEmitter } from 'node:events';
import type { BotLike, SttLike } from './session.js';

/**
 * Stand-ins that let a MeetingSession run with no Teams call and no paid
 * service: the owner types what participants say, and the assistant's replies
 * appear as text. The brain (Claude) is the real one.
 */

/** A "meeting" that exists only in the dashboard. */
export class RehearsalBot extends EventEmitter implements BotLike {
  async join(): Promise<void> {}
  async play(): Promise<number> {
    return 0;
  }
  async stopSpeaking(): Promise<void> {}
  async queuedSeconds(): Promise<number> {
    return 0;
  }
  async setMuted(): Promise<void> {}
  async raiseHand(): Promise<void> {}
  async sendChat(): Promise<boolean> {
    return true;
  }
  async leave(): Promise<void> {}
}

/** Nothing to transcribe: lines arrive through MeetingSession.hear(). */
export class NoStt extends EventEmitter implements SttLike {
  readonly secondsSent = 0;
  readonly usesCaptions = false;
  start(): void {}
  send(): void {}
  stop(): void {}
}

/** The voice in a rehearsal: says nothing and costs nothing. */
export async function silentVoice(): Promise<void> {}
