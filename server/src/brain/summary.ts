import { config } from '../config.js';
import type { Utterance } from '../db.js';
import { askOnce } from './llm.js';
import { summarySystemPrompt } from './prompts.js';

/**
 * A few sentences on what has just been said, for an owner checking on a
 * meeting they are not in. Uses the fast model: this is asked for mid-meeting.
 */
export async function catchUpMeeting(ownerName: string, title: string, utterances: Utterance[]): Promise<string> {
  const since = Date.now() - config.catchUpMinutes * 60_000;
  const stamp = (u: Utterance) => new Date(u.ts.replace(' ', 'T') + 'Z').getTime();
  let recent = utterances.filter((u) => stamp(u) >= since);
  // A quiet stretch: fall back to the last few lines so there is something to report.
  if (recent.length < 3) recent = utterances.slice(-12);
  if (!recent.length) return 'Nothing has been said yet.';
  const transcript = recent.map((u) => `${u.speaker}${u.is_agent ? ' (assistant)' : ''}: ${u.text}`).join('\n');
  return (
    await askOnce(
      `You brief ${ownerName} on a meeting that is still going on, which an AI assistant is attending for them. From the latest part of the transcript (speech recognition, so names may be misspelled), say in two to four plain sentences what is being discussed right now and anything that involves ${ownerName}: questions for them, decisions, or things said on their behalf (lines marked "(assistant)"). No preamble, no markdown, no lists. Only what the transcript supports.`,
      `Meeting: ${title || '(untitled)'}\n\n<latest_transcript>\n${transcript}\n</latest_transcript>`,
      config.catchUpModel,
    )
  ).trim();
}

/** Write the post-meeting notes from the saved transcript. */
export async function summarizeMeeting(ownerName: string, title: string, utterances: Utterance[]): Promise<string> {
  const transcript = utterances
    .map((u) => `${u.speaker}${u.is_agent ? ' (assistant)' : ''}: ${u.text}`)
    .join('\n');
  return (
    await askOnce(
      summarySystemPrompt(ownerName),
      `Meeting: ${title || '(untitled)'}\n\n<transcript>\n${transcript}\n</transcript>`,
    )
  ).trim();
}
