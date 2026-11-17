import Database from 'better-sqlite3';
import { config } from './config.js';

export type MeetingStatus = 'scheduled' | 'starting' | 'lobby' | 'live' | 'ended' | 'failed';

/** A rehearsal is a text-only practice run: no Teams, no ElevenLabs. */
export type MeetingKind = 'teams' | 'rehearsal';
export type NotifyMode = 'live' | 'collect';

/** A Telegram message the assistant sent, so a reply or button press finds its meeting. */
export interface TgMessage {
  message_id: number;
  meeting_id: number;
  question_id: number | null;
}

export interface Meeting {
  id: number;
  kind: MeetingKind;
  /** When to join (UTC, "YYYY-MM-DD HH:MM:SS"), for meetings set up ahead of time. */
  scheduled_at: string | null;
  /** 'live': unanswered questions reach the owner at once. 'collect': they wait for the summary. */
  notify_mode: NotifyMode;
  link: string;
  title: string;
  update_text: string;
  context: string;
  do_not_discuss: string;
  status: MeetingStatus;
  error: string | null;
  summary: string | null;
  /** Why the assistant is no longer in the meeting, in plain words. */
  end_reason: string | null;
  created_at: string;
  ended_at: string | null;
  stt_seconds: number;
  tts_chars: number;
  /** The meeting browser's memory (MB) and CPU (cores), measured while it ran. */
  ram_peak_mb: number | null;
  ram_avg_mb: number | null;
  cpu_avg: number | null;
}

export interface Utterance {
  id: number;
  meeting_id: number;
  ts: string;
  speaker: string;
  text: string;
  is_agent: number;
}

export type QuestionStatus = 'pending' | 'answered' | 'relayed';

export interface Question {
  id: number;
  meeting_id: number;
  ts: string;
  asker: string;
  question: string;
  status: QuestionStatus;
  answer: string | null;
}

// AB_DB_PATH=:memory: keeps tests away from the real database.
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    update_text TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    do_not_discuss TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'starting',
    error TEXT,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    stt_seconds REAL NOT NULL DEFAULT 0,
    tts_chars INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS utterances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    is_agent INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    asker TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT
  );
`);

// Columns added after the first release: add them to an existing database.
const meetingColumns = new Set(
  (db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).map((c) => c.name),
);
if (!meetingColumns.has('kind')) db.exec(`ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'teams'`);
if (!meetingColumns.has('scheduled_at')) db.exec('ALTER TABLE meetings ADD COLUMN scheduled_at TEXT');
for (const col of ['ram_peak_mb', 'ram_avg_mb', 'cpu_avg']) {
  if (!meetingColumns.has(col)) db.exec(`ALTER TABLE meetings ADD COLUMN ${col} REAL`);
}
if (!meetingColumns.has('end_reason')) db.exec('ALTER TABLE meetings ADD COLUMN end_reason TEXT');
if (!meetingColumns.has('notify_mode')) db.exec(`ALTER TABLE meetings ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'live'`);
db.exec(`
  CREATE TABLE IF NOT EXISTS tg_messages (
    message_id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL,
    question_id INTEGER
  );
`);

/** A JS time as SQLite stores it: UTC "YYYY-MM-DD HH:MM:SS". */
export function toDbTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function fromDbTime(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

// A meeting left "live" by a crashed or restarted server is over.
db.prepare(
  `UPDATE meetings SET status = 'failed', error = 'Server restarted during the meeting', ended_at = datetime('now')
   WHERE status IN ('starting', 'lobby', 'live')`,
).run();

export const store = {
  createMeeting(
    m: Pick<Meeting, 'link' | 'title' | 'update_text' | 'context' | 'do_not_discuss'> &
      Partial<Pick<Meeting, 'kind' | 'scheduled_at' | 'notify_mode'>>,
  ): Meeting {
    const info = db
      .prepare(
        `INSERT INTO meetings (link, title, update_text, context, do_not_discuss, kind, scheduled_at, notify_mode, status)
         VALUES (@link, @title, @update_text, @context, @do_not_discuss, @kind, @scheduled_at, @notify_mode, @status)`,
      )
      .run({
        ...m,
        kind: m.kind ?? 'teams',
        scheduled_at: m.scheduled_at ?? null,
        notify_mode: m.notify_mode ?? 'live',
        status: m.scheduled_at ? 'scheduled' : 'starting',
      });
    return this.getMeeting(Number(info.lastInsertRowid))!;
  },
  listScheduled(): Meeting[] {
    return db.prepare(`SELECT * FROM meetings WHERE status = 'scheduled' ORDER BY scheduled_at`).all() as Meeting[];
  },
  /** A scheduled meeting is starting now: its clock runs from this moment. */
  markStarted(id: number): void {
    db.prepare(`UPDATE meetings SET status = 'starting', created_at = datetime('now') WHERE id = ?`).run(id);
  },
  /** Only for meetings that never ran, so there is nothing else to remove. */
  deleteMeeting(id: number): void {
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  },
  getMeeting(id: number): Meeting | undefined {
    return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Meeting | undefined;
  },
  listMeetings(): Meeting[] {
    return db.prepare('SELECT * FROM meetings ORDER BY id DESC').all() as Meeting[];
  },
  setStatus(id: number, status: MeetingStatus, error: string | null = null): void {
    const ended = status === 'ended' || status === 'failed';
    db.prepare(
      `UPDATE meetings SET status = ?, error = ?, ended_at = CASE WHEN ? THEN datetime('now') ELSE ended_at END WHERE id = ?`,
    ).run(status, error, ended ? 1 : 0, id);
  },
  setResourceUsage(id: number, peakMb: number, avgMb: number, cpuAvg: number | null): void {
    db.prepare('UPDATE meetings SET ram_peak_mb = ?, ram_avg_mb = ?, cpu_avg = ? WHERE id = ?').run(peakMb, avgMb, cpuAvg, id);
  },
  setEndReason(id: number, reason: string): void {
    db.prepare('UPDATE meetings SET end_reason = ? WHERE id = ?').run(reason, id);
  },
  setSummary(id: number, summary: string): void {
    db.prepare('UPDATE meetings SET summary = ? WHERE id = ?').run(summary, id);
  },
  addUsage(id: number, sttSeconds: number, ttsChars: number): void {
    db.prepare('UPDATE meetings SET stt_seconds = stt_seconds + ?, tts_chars = tts_chars + ? WHERE id = ?').run(
      sttSeconds,
      ttsChars,
      id,
    );
  },

  /** Voice characters spent in real meetings since `since` (rehearsals spend nothing). */
  ttsCharsSince(since: Date): number {
    const row = db
      .prepare(`SELECT COALESCE(SUM(tts_chars), 0) AS n FROM meetings WHERE kind = 'teams' AND created_at >= ?`)
      .get(toDbTime(since)) as { n: number };
    return row.n;
  },

  saveTgMessage(messageId: number, meetingId: number, questionId: number | null = null): void {
    db.prepare('INSERT OR REPLACE INTO tg_messages (message_id, meeting_id, question_id) VALUES (?, ?, ?)').run(
      messageId,
      meetingId,
      questionId,
    );
  },
  getTgMessage(messageId: number): TgMessage | undefined {
    return db.prepare('SELECT * FROM tg_messages WHERE message_id = ?').get(messageId) as TgMessage | undefined;
  },

  addUtterance(meetingId: number, speaker: string, text: string, isAgent = false): Utterance {
    const info = db
      .prepare('INSERT INTO utterances (meeting_id, speaker, text, is_agent) VALUES (?, ?, ?, ?)')
      .run(meetingId, speaker, text, isAgent ? 1 : 0);
    return db.prepare('SELECT * FROM utterances WHERE id = ?').get(info.lastInsertRowid) as Utterance;
  },
  setUtteranceSpeaker(id: number, speaker: string): void {
    db.prepare('UPDATE utterances SET speaker = ? WHERE id = ?').run(speaker, id);
  },
  listUtterances(meetingId: number): Utterance[] {
    return db.prepare('SELECT * FROM utterances WHERE meeting_id = ? ORDER BY id').all(meetingId) as Utterance[];
  },

  addQuestion(meetingId: number, asker: string, question: string): Question {
    const info = db
      .prepare('INSERT INTO questions (meeting_id, asker, question) VALUES (?, ?, ?)')
      .run(meetingId, asker, question);
    return this.getQuestion(Number(info.lastInsertRowid))!;
  },
  getQuestion(id: number): Question | undefined {
    return db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Question | undefined;
  },
  listQuestions(meetingId: number): Question[] {
    return db.prepare('SELECT * FROM questions WHERE meeting_id = ? ORDER BY id').all(meetingId) as Question[];
  },
  answerQuestion(id: number, answer: string, status: QuestionStatus): void {
    db.prepare('UPDATE questions SET answer = ?, status = ? WHERE id = ?').run(answer, status, id);
  },
};
