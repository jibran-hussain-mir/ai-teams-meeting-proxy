export type MeetingStatus = 'scheduled' | 'starting' | 'lobby' | 'live' | 'ended' | 'failed';

export interface Meeting {
  id: number;
  /** A rehearsal is a text-only practice run. */
  kind: 'teams' | 'rehearsal';
  /** UTC join time for a meeting set up ahead of time. */
  scheduled_at: string | null;
  /** 'collect' holds unanswered questions for the summary instead of messaging you. */
  notify_mode: 'live' | 'collect';
  link: string;
  title: string;
  update_text: string;
  context: string;
  do_not_discuss: string;
  status: MeetingStatus;
  error: string | null;
  summary: string | null;
  /** Why the assistant is no longer in the meeting. */
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

/** What one meeting's browser is using right now. */
export interface BrowserUsage {
  processes: number;
  memMb: number;
  cores: number | null;
}

export interface Utterance {
  id: number;
  meeting_id: number;
  ts: string;
  speaker: string;
  text: string;
  is_agent: number;
}

export interface Question {
  id: number;
  meeting_id: number;
  ts: string;
  asker: string;
  question: string;
  status: 'pending' | 'answered' | 'relayed';
  answer: string | null;
}

export type AgentState = 'listening' | 'thinking' | 'waiting' | 'speaking';

export interface Setup {
  ownerName: string;
  botName: string;
  missing: string[];
  hasVoice: boolean;
  telegram: boolean;
  /** Meetings the assistant is in right now, oldest first. */
  activeMeetings: ActiveMeeting[];
  /** How many real meetings it may attend at once. */
  maxMeetings: number;
  limits?: {
    sttMode: 'captions' | 'elevenlabs';
    sttMaxMinutes: number;
    ttsMaxChars: number;
    ttsDailyMaxChars: number;
    ttsSpentToday: number;
    voiceTestMaxChars: number;
  };
}

export interface ActiveMeeting {
  id: number;
  title: string;
  kind: Meeting['kind'];
  /** Position among simultaneous meetings; decides the colour. */
  slot: number;
  status: MeetingStatus;
  /** Questions waiting for you. */
  pending: number;
}

export interface MeetingDetail {
  meeting: Meeting;
  utterances: Utterance[];
  questions: Question[];
  agent: { state: AgentState; muted: boolean } | null;
  slot: number | null;
  resources: BrowserUsage | null;
}

/** One running meeting as shown on the overview page. */
export interface LiveMeeting {
  meeting: Meeting;
  slot: number;
  agent: { state: AgentState; muted: boolean };
  lines: number;
  recent: Utterance[];
  questions: Question[];
  resources: BrowserUsage | null;
}

/** Real meetings in progress (rehearsals do not use up places). */
export function slotsUsed(setup: Setup | null): number {
  return setup?.activeMeetings.filter((m) => m.kind === 'teams').length ?? 0;
}

export type DashboardEvent =
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'partial'; meetingId: number; text: string }
  | { type: 'question'; question: Question }
  | { type: 'agent'; meetingId: number; state: AgentState; muted: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Cannot reach the server. Is it running?');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  setup: () => request<Setup>('/api/setup'),
  meetings: () => request<Meeting[]>('/api/meetings'),
  meeting: (id: number) => request<MeetingDetail>(`/api/meetings/${id}`),
  createMeeting: (body: {
    link: string;
    title: string;
    update: string;
    context: string;
    doNotDiscuss: string;
    rehearsal?: boolean;
    /** ISO time to join at; leave out to join now. */
    startAt?: string;
    notifyMode?: 'live' | 'collect';
  }) => request<Meeting>('/api/meetings', json(body)),
  live: () => request<LiveMeeting[]>('/api/live'),
  startNow: (id: number) => request(`/api/meetings/${id}/start`, json({})),
  cancel: (id: number) => request(`/api/meetings/${id}`, { method: 'DELETE' }),
  hear: (id: number, speaker: string, text: string) => request(`/api/meetings/${id}/hear`, json({ speaker, text })),
  lull: (id: number) => request(`/api/meetings/${id}/lull`, json({})),
  say: (id: number, text: string) => request(`/api/meetings/${id}/say`, json({ text })),
  mute: (id: number, muted: boolean) => request(`/api/meetings/${id}/mute`, json({ muted })),
  leave: (id: number) => request(`/api/meetings/${id}/leave`, json({})),
  answer: (questionId: number, answer: string) =>
    request<{ message: string }>(`/api/questions/${questionId}/answer`, json({ answer })),
  extract: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ name: string; text: string }>('/api/extract', { method: 'POST', body: form });
  },
  createVoice: (files: { blob: Blob; name: string }[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f.blob, f.name);
    return request<{ voiceId: string }>('/api/voice', { method: 'POST', body: form });
  },
  testVoice: async (text: string): Promise<Blob> => {
    const res = await fetch('/api/voice/test', json({ text }));
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Voice test failed');
    return res.blob();
  },
};

/** Live event feed. Reconnects on its own; returns a function to stop. */
export function subscribe(onEvent: (e: DashboardEvent) => void, onReconnect?: () => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let first = true;
  const connect = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      if (!first) onReconnect?.();
      first = false;
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {}
    };
    ws.onclose = () => {
      if (!stopped) setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
