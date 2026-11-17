import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import type { WebSocket } from 'ws';
import { extractText, getDocumentProxy } from 'unpdf';
import os from 'node:os';
import path from 'node:path';
import { config, DATA_DIR, missingSetup, saveEnvValue } from './config.js';
import { fromDbTime, store, toDbTime, type Meeting } from './db.js';
import { Slots, startOfToday, VoiceBudget } from './audio/budget.js';
import { CaptionStt } from './audio/captions.js';
import { RealtimeStt } from './audio/stt.js';
import { createVoiceClone, pcmToWav, synthesize } from './audio/tts.js';
import { withVoiceCache } from './audio/voice-cache.js';
import { ClaudeSession } from './brain/llm.js';
import { catchUpMeeting, summarizeMeeting } from './brain/summary.js';
import { TeamsBot } from './bot/teams.js';
import { ManagerError, MeetingManager, meetingTag, type Running } from './meeting/manager.js';
import { NoStt, RehearsalBot, silentVoice } from './meeting/rehearsal.js';
import { scheduleAction } from './meeting/schedule.js';
import { MeetingSession, type DashboardEvent } from './meeting/session.js';
import { TelegramHub } from './notify/hub.js';
import { TelegramTransport } from './notify/telegram.js';

function isTeamsLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && config.teamsHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const app = Fastify({ logger: { level: 'warn' } });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 5 } });

// ---- Live dashboard feed ----------------------------------------------------

const sockets = new Set<WebSocket>();
function broadcast(event: DashboardEvent): void {
  const data = JSON.stringify(event);
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
}
app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// ---- Meetings in progress ---------------------------------------------------

/** Shared by every meeting so that several at once cannot overspend ElevenLabs credit. */
const voiceBudget = new VoiceBudget(config.ttsDailyMaxChars, () => store.ttsCharsSince(startOfToday()));
/** ElevenLabs limits how many requests may run at once. */
const voiceSlots = new Slots(config.ttsConcurrency);

/**
 * The thinking fillers are the same few lines every time, so their audio is
 * kept on disk after the first use and replayed without spending credits.
 */
const speak = withVoiceCache(
  synthesize,
  path.join(DATA_DIR, 'voice-cache'),
  (text) => config.fillerLines.includes(text),
  () => config.elevenLabsVoiceId,
);

const telegram = new TelegramTransport();

const manager: MeetingManager = new MeetingManager({
  max: () => config.maxMeetings,
  create(meeting, slot, onEnded) {
    const shared = {
      createLlm: (system: string) => new ClaudeSession(system),
      summarize: summarizeMeeting,
      broadcast,
      notifier: hub.forMeeting(meeting.id, meetingTag(slot, meeting.kind, meeting.title)),
      doNotDisturb: () => hub.dnd,
      onEnded,
      fillers: config.fillers ? config.fillerLines : [],
    };
    // A rehearsal touches neither Teams nor ElevenLabs.
    return meeting.kind === 'rehearsal'
      ? new MeetingSession(meeting, {
          ...shared,
          createBot: async () => new RehearsalBot(),
          createStt: () => new NoStt(),
          createCaptionStt: () => new NoStt(),
          synthesize: silentVoice,
        })
      : new MeetingSession(meeting, {
          ...shared,
          createBot: (onAudio) => TeamsBot.launch({ headless: config.headless, onAudio, slot }),
          createStt: (keyterms) =>
            config.sttMode === 'elevenlabs'
              ? new RealtimeStt(keyterms, config.sttMaxMinutes * 60)
              : new CaptionStt(config.botDisplayName, config.captionStableMs, config.captionSentenceStableMs),
          createCaptionStt: () =>
            new CaptionStt(config.botDisplayName, config.captionStableMs, config.captionSentenceStableMs),
          synthesize: (text, onChunk, opts) => voiceSlots.run(() => speak(text, onChunk, opts)),
          voiceBudget,
        });
  },
});

function phaseOf(r: Running): 'joining' | 'lobby' | 'live' {
  const status = store.getMeeting(r.meetingId)?.status;
  return status === 'live' ? 'live' : status === 'lobby' ? 'lobby' : 'joining';
}

const GONE = 'That meeting is no longer running.';

const hub: TelegramHub = new TelegramHub(telegram, {
  live: () =>
    manager.live().map((r) => ({
      id: r.meetingId,
      tag: r.tag,
      phase: phaseOf(r),
      agent: r.session.agentState,
      muted: r.session.muted,
      pending: r.session.pendingQuestions.length,
      startedAt: r.startedAt,
    })),
  upcoming: () => store.listScheduled().map((m) => ({ title: m.title, at: fromDbTime(m.scheduled_at ?? '') })),
  pending: () =>
    manager.live().flatMap((r) =>
      r.session.pendingQuestions.map((q) => ({
        id: q.id,
        meetingId: q.meeting_id,
        asker: q.asker,
        question: q.question,
      })),
    ),
  say(meetingId, text) {
    const r = manager.get(meetingId);
    if (!r) return GONE;
    if (r.session.muted) return 'The assistant is muted there. Unmute it first.';
    r.session.sayNow(text);
    return 'Will say it at the next gap.';
  },
  async mute(meetingId, muted) {
    const r = manager.get(meetingId);
    if (!r) return GONE;
    await r.session.setMuted(muted);
    return muted ? 'Muted. The assistant will stay silent.' : 'Unmuted.';
  },
  leave(meetingId) {
    const r = manager.get(meetingId);
    if (!r) return GONE;
    void r.session.stop('you asked it to leave');
    return 'Leaving. The summary will follow.';
  },
  answer: (questionId, text) => answerQuestion(questionId, text),
  followUp(questionId) {
    const question = store.getQuestion(questionId);
    if (!question) return 'That question no longer exists.';
    if (question.status !== 'pending') return 'That question has already been dealt with.';
    const r = manager.get(question.meeting_id);
    if (r) {
      r.session.followUpLater(question);
      return r.session.muted
        ? 'Closed. Nothing was said because the assistant is muted.'
        : 'Okay. I will tell them you will follow up after the meeting.';
    }
    store.answerQuestion(questionId, 'You chose to follow up after the meeting.', 'answered');
    broadcast({ type: 'question', question: store.getQuestion(questionId)! });
    return 'Closed. The meeting is over, so nothing was said.';
  },
  async catchUp(meetingId) {
    const meeting = store.getMeeting(meetingId);
    if (!meeting) return 'That meeting no longer exists.';
    try {
      return await catchUpMeeting(config.ownerName, meeting.title, store.listUtterances(meetingId));
    } catch (err) {
      return `Could not write a catch-up: ${(err as Error).message}`;
    }
  },
});
telegram.start(hub);

function answerQuestion(questionId: number, answer: string): string {
  const question = store.getQuestion(questionId);
  if (!question) return 'That question no longer exists.';
  const s = manager.get(question.meeting_id)?.session;
  if (s && !s.muted) {
    s.relayAnswer(question, answer);
    return 'Got it. I will pass that on at the next gap.';
  }
  store.answerQuestion(questionId, answer, 'answered');
  broadcast({ type: 'question', question: store.getQuestion(questionId)! });
  return s?.muted
    ? 'Saved, but not spoken because the assistant is muted.'
    : 'Saved, but the meeting is over so it was not spoken.';
}

function sessionFor(id: string): MeetingSession | null {
  return manager.get(Number(id))?.session ?? null;
}

// ---- API --------------------------------------------------------------------

app.get('/api/setup', async () => ({
  ownerName: config.ownerName,
  botName: config.botDisplayName,
  missing: missingSetup(),
  hasVoice: config.elevenLabsVoiceId !== '',
  telegram: telegram.enabled,
  activeMeetings: manager.live().map((r) => ({
    id: r.meetingId,
    title: r.title,
    kind: r.kind,
    slot: r.slot,
    status: store.getMeeting(r.meetingId)?.status ?? 'starting',
    pending: r.session.pendingQuestions.length,
  })),
  maxMeetings: config.maxMeetings,
  limits: {
    sttMode: config.sttMode,
    sttMaxMinutes: config.sttMaxMinutes,
    ttsMaxChars: config.ttsMaxChars,
    ttsDailyMaxChars: config.ttsDailyMaxChars,
    ttsSpentToday: voiceBudget.spent,
    voiceTestMaxChars: config.voiceTestMaxChars,
  },
}));

/** Everything needed to watch all running meetings on one screen. */
app.get('/api/live', async () =>
  manager.live().map((r) => {
    const utterances = store.listUtterances(r.meetingId);
    return {
      meeting: store.getMeeting(r.meetingId)!,
      slot: r.slot,
      agent: { state: r.session.agentState, muted: r.session.muted },
      lines: utterances.length,
      recent: utterances.slice(-4),
      questions: r.session.pendingQuestions,
      resources: r.session.resourceNow,
    };
  }),
);

app.get('/api/meetings', async () => store.listMeetings());

app.get<{ Params: { id: string } }>('/api/meetings/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const meeting = store.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: 'No such meeting' });
  const r = manager.get(id);
  return {
    meeting,
    utterances: store.listUtterances(id),
    questions: store.listQuestions(id),
    agent: r ? { state: r.session.agentState, muted: r.session.muted } : null,
    slot: r?.slot ?? null,
    resources: r?.session.resourceNow ?? null,
  };
});

app.post<{
  Body: {
    link?: string;
    title?: string;
    update?: string;
    context?: string;
    doNotDiscuss?: string;
    /** Practice run in the dashboard instead of a real meeting. */
    rehearsal?: boolean;
    /** ISO time to join at; omitted means now. */
    startAt?: string;
    /** 'collect' holds unanswered questions for the summary instead of messaging the owner. */
    notifyMode?: string;
  };
}>('/api/meetings', async (req, reply) => {
  const body = req.body ?? {};
  const link = (body.link ?? '').trim();
  const brief = {
    title: (body.title ?? '').trim(),
    update_text: body.update ?? '',
    context: body.context ?? '',
    do_not_discuss: body.doNotDiscuss ?? '',
    notify_mode: body.notifyMode === 'collect' ? ('collect' as const) : ('live' as const),
  };

  if (body.rehearsal) {
    // Only the brain is real in a rehearsal, so the voice and Teams setup are not needed.
    if (!config.ownerName) return reply.code(400).send({ error: 'Set OWNER_NAME in .env first.' });
    const full = manager.blocked({ kind: 'rehearsal', link: '' });
    if (full) return reply.code(409).send({ error: full });
    const meeting = store.createMeeting({ ...brief, link: '', title: brief.title || 'Rehearsal', kind: 'rehearsal' });
    manager.start(meeting);
    return meeting;
  }

  if (!isTeamsLink(link)) {
    return reply.code(400).send({ error: 'That does not look like a Microsoft Teams meeting link.' });
  }
  const missing = missingSetup();
  if (missing.length) return reply.code(400).send({ error: `Set these up first: ${missing.join(', ')}` });

  if (body.startAt) {
    const at = new Date(body.startAt);
    if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: 'That start time is not valid.' });
    if (at.getTime() <= Date.now()) return reply.code(400).send({ error: 'That start time has already passed.' });
    return store.createMeeting({ ...brief, link, scheduled_at: toDbTime(at) });
  }

  const full = manager.blocked({ kind: 'teams', link });
  if (full) return reply.code(409).send({ error: full });
  const meeting = store.createMeeting({ ...brief, link });
  manager.start(meeting);
  return meeting;
});

// ---- Scheduled meetings -----------------------------------------------------

const reminded = new Set<number>();

function beginScheduled(meeting: Meeting): void {
  store.markStarted(meeting.id);
  const started = store.getMeeting(meeting.id)!;
  broadcast({ type: 'meeting', meeting: started });
  manager.start(started);
}

/** Join, remind about, or give up on scheduled meetings. Runs every few seconds. */
function runSchedule(): void {
  for (const meeting of store.listScheduled()) {
    const name = meeting.title || 'Your meeting';
    const action = scheduleAction(meeting, Date.now(), {
      busy: manager.blocked(meeting) !== null,
      missing: missingSetup(),
      reminded: reminded.has(meeting.id),
    });
    if (action.do === 'remind') {
      reminded.add(meeting.id);
      void hub.announce(
        `⏰ ${name}\nThe assistant will join in about ${action.minutes} minute${action.minutes === 1 ? '' : 's'}. Open the app to cancel.`,
      );
    } else if (action.do === 'start') {
      try {
        beginScheduled(meeting);
      } catch (err) {
        if (!(err instanceof ManagerError)) throw err;
        // Lost the place to another meeting in the same moment: try again next round.
      }
    } else if (action.do === 'fail') {
      store.setStatus(meeting.id, 'failed', action.reason);
      broadcast({ type: 'meeting', meeting: store.getMeeting(meeting.id)! });
      void hub.announce(`⚠️ ${name}\nThe assistant did not join: ${action.reason}.`);
    }
  }
}

/** Join a scheduled meeting straight away. */
app.post<{ Params: { id: string } }>('/api/meetings/:id/start', async (req, reply) => {
  const meeting = store.getMeeting(Number(req.params.id));
  if (!meeting || meeting.status !== 'scheduled') return reply.code(409).send({ error: 'That meeting is not waiting to start.' });
  const missing = missingSetup();
  if (missing.length) return reply.code(400).send({ error: `Set these up first: ${missing.join(', ')}` });
  const full = manager.blocked(meeting);
  if (full) return reply.code(409).send({ error: full });
  beginScheduled(meeting);
  return { ok: true };
});

/** Cancel a scheduled meeting. Meetings that ran are kept as history. */
app.delete<{ Params: { id: string } }>('/api/meetings/:id', async (req, reply) => {
  const meeting = store.getMeeting(Number(req.params.id));
  if (!meeting || meeting.status !== 'scheduled') {
    return reply.code(409).send({ error: 'Only a meeting that has not started can be cancelled.' });
  }
  store.deleteMeeting(meeting.id);
  reminded.delete(meeting.id);
  return { ok: true };
});

// ---- Rehearsal: the owner plays the other participants ------------------------

function rehearsalFor(id: string): MeetingSession | null {
  const r = manager.get(Number(id));
  return r?.kind === 'rehearsal' ? r.session : null;
}

app.post<{ Params: { id: string }; Body: { speaker?: string; text?: string } }>(
  '/api/meetings/:id/hear',
  async (req, reply) => {
    const s = rehearsalFor(req.params.id);
    const text = (req.body?.text ?? '').trim();
    if (!s) return reply.code(409).send({ error: 'That rehearsal is not running.' });
    if (!text) return reply.code(400).send({ error: 'Nothing was said.' });
    s.hear((req.body?.speaker ?? '').trim() || 'Someone', text);
    return { ok: true };
  },
);

app.post<{ Params: { id: string } }>('/api/meetings/:id/lull', async (req, reply) => {
  const s = rehearsalFor(req.params.id);
  if (!s) return reply.code(409).send({ error: 'That rehearsal is not running.' });
  if (!s.simulateLull()) {
    return reply.code(409).send({
      error: s.muted
        ? 'The assistant is muted, so it would stay silent.'
        : 'The update has already been given (or there is none), so the assistant stays quiet in a silence.',
    });
  }
  return { ok: true };
});

// ---- Controls for a running meeting -----------------------------------------

app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/meetings/:id/say', async (req, reply) => {
  const s = sessionFor(req.params.id);
  const text = (req.body?.text ?? '').trim();
  if (!s) return reply.code(409).send({ error: 'That meeting is not running.' });
  if (!text) return reply.code(400).send({ error: 'Nothing to say.' });
  if (s.muted) return reply.code(409).send({ error: 'The assistant is muted. Unmute it first.' });
  s.sayNow(text);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { muted?: boolean } }>('/api/meetings/:id/mute', async (req, reply) => {
  const s = sessionFor(req.params.id);
  if (!s) return reply.code(409).send({ error: 'That meeting is not running.' });
  await s.setMuted(Boolean(req.body?.muted));
  hub.refreshCard(s.meetingId);
  return { ok: true, muted: s.muted };
});

app.post<{ Params: { id: string } }>('/api/meetings/:id/leave', async (req, reply) => {
  const s = sessionFor(req.params.id);
  if (!s) return reply.code(409).send({ error: 'That meeting is not running.' });
  void s.stop('you asked it to leave');
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { answer?: string } }>('/api/questions/:id/answer', async (req, reply) => {
  const answer = (req.body?.answer ?? '').trim();
  if (!answer) return reply.code(400).send({ error: 'The answer is empty.' });
  const message = answerQuestion(Number(req.params.id), answer);
  const question = store.getQuestion(Number(req.params.id));
  if (question) hub.refreshCard(question.meeting_id);
  return { message };
});

/** Turn an uploaded .txt, .md or .pdf into text for the context box. */
app.post('/api/extract', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file uploaded.' });
  const data = await file.toBuffer();
  const name = file.filename.toLowerCase();
  if (name.endsWith('.pdf')) {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { text } = await extractText(pdf, { mergePages: true });
      return { name: file.filename, text: text.trim() };
    } catch {
      return reply.code(400).send({ error: 'Could not read that PDF.' });
    }
  }
  if (/\.(txt|md|markdown|csv|json|log)$/.test(name)) return { name: file.filename, text: data.toString('utf8').trim() };
  return reply.code(400).send({ error: 'Only .txt, .md and .pdf files are supported.' });
});

/** Create the voice clone from recorded or uploaded samples. */
app.post('/api/voice', async (req, reply) => {
  if (!config.elevenLabsApiKey) return reply.code(400).send({ error: 'Add ELEVENLABS_API_KEY to .env first.' });
  const samples: { filename: string; data: Buffer; mimeType: string }[] = [];
  for await (const part of req.files()) {
    samples.push({ filename: part.filename, data: await part.toBuffer(), mimeType: part.mimetype });
  }
  if (!samples.length) return reply.code(400).send({ error: 'No audio uploaded.' });
  try {
    const voiceId = await createVoiceClone(`${config.ownerName} (Proxy)`, samples);
    saveEnvValue('ELEVENLABS_VOICE_ID', voiceId);
    return { voiceId };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

/** Hear the cloned voice say a test sentence. */
app.post<{ Body: { text?: string } }>('/api/voice/test', async (req, reply) => {
  if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) {
    return reply.code(400).send({ error: 'Create your voice first.' });
  }
  // Kept short: every test spends ElevenLabs credits.
  const text = (req.body?.text ?? '').trim().slice(0, config.voiceTestMaxChars) || `Hi, this is ${config.ownerName}'s AI assistant.`;
  const chunks: Buffer[] = [];
  try {
    await synthesize(text, (pcm) => void chunks.push(pcm));
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
  return reply.type('audio/wav').send(pcmToWav(Buffer.concat(chunks)));
});

// ---- Start ------------------------------------------------------------------

async function shutdown(): Promise<void> {
  await manager.stopAll('the server was shut down');
  await telegram.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Local only: there is no login, so never listen on the network.
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Proxy server on http://127.0.0.1:${config.port}`);
const missing = missingSetup();
if (missing.length) console.log(`Still to set up: ${missing.join(', ')}`);
console.log(
  config.sttMode === 'elevenlabs'
    ? `Transcription: ElevenLabs (paid), at most ${config.sttMaxMinutes} min per meeting, then Teams captions`
    : 'Transcription: Teams live captions (free)',
);
console.log(
  `Voice: at most ${config.ttsMaxChars} characters per meeting and ${config.ttsDailyMaxChars} per day, then replies go to chat`,
);
console.log(`Meetings at once: up to ${config.maxMeetings}`);

runSchedule();
setInterval(runSchedule, 10_000);

/** One console line with every meeting's browser and the machine's free memory. */
function logResources(): void {
  const measured = manager.live().filter((r) => r.session.resourceNow);
  if (!measured.length) return;
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const parts = measured.map((r) => {
    const u = r.session.resourceNow!;
    const cpu = u.cores === null ? '' : `, ${u.cores.toFixed(2)} cores`;
    return `${r.tag}: ${Math.round(u.memMb)} MB${cpu} (${u.processes} processes)`;
  });
  const total = measured.reduce((n, r) => n + r.session.resourceNow!.memMb, 0);
  console.log(
    `[resources] ${parts.join(' · ')} · all meetings ${(total / 1024).toFixed(2)} GB · machine ${gb(os.freemem())} of ${gb(os.totalmem())} GB free`,
  );
}
if (config.timing.resourceSampleMs > 0) setInterval(logResources, config.timing.resourceSampleMs);
const waiting = store.listScheduled().length;
if (waiting) console.log(`Scheduled meetings waiting to start: ${waiting}`);
