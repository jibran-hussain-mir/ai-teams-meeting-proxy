import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, slotsUsed, subscribe, type AgentState, type MeetingDetail, type Question, type Setup } from '../lib/api';
import {
  Callout,
  Card,
  formatDuration,
  Icon,
  initials,
  PageHeader,
  parseTs,
  Skeleton,
  speakerHue,
  Stat,
  StatusBadge,
} from '../ui';

const AGENT_TEXT: Record<AgentState, [string, string]> = {
  listening: ['Listening', 'Following the conversation'],
  thinking: ['Thinking', 'Deciding whether to speak'],
  waiting: ['Waiting for a gap', 'It will not talk over anyone'],
  speaking: ['Speaking', 'In your voice'],
};

const time = (ts: string) => parseTs(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Re-renders once a second while `active`, for the running clock. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function MeetingPage({ setup, onChange }: { setup: Setup | null; onChange: () => void }) {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [sayText, setSayText] = useState('');
  const transcriptEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      api
        .meeting(id)
        .then(setDetail)
        .catch((e: Error) => setError(e.message));
    void load();
    return subscribe((e) => {
      setDetail((d) => {
        if (!d) return d;
        switch (e.type) {
          case 'meeting':
            if (e.meeting.id !== id) return d;
            if (e.meeting.status !== d.meeting.status) onChange();
            return { ...d, meeting: e.meeting, agent: e.meeting.status === 'live' ? d.agent : null };
          case 'utterance':
            if (e.utterance.meeting_id !== id || d.utterances.some((u) => u.id === e.utterance.id)) return d;
            return { ...d, utterances: [...d.utterances, e.utterance] };
          case 'question': {
            if (e.question.meeting_id !== id) return d;
            const rest = d.questions.filter((q) => q.id !== e.question.id);
            return { ...d, questions: [...rest, e.question].sort((a, b) => a.id - b.id) };
          }
          case 'agent':
            return e.meetingId === id ? { ...d, agent: { state: e.state, muted: e.muted } } : d;
          default:
            return d;
        }
      });
      if (e.type === 'partial' && e.meetingId === id) setPartial(e.text);
    }, load);
  }, [id]);

  useEffect(() => {
    // Scroll the transcript box only, never the page.
    const box = transcriptEnd.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [detail?.utterances.length, partial]);

  const running =
    detail?.meeting.status === 'starting' || detail?.meeting.status === 'lobby' || detail?.meeting.status === 'live';
  const now = useNow(Boolean(running));

  if (error && !detail) return <Callout kind="error">{error}</Callout>;
  if (!detail) {
    return (
      <Card>
        <Skeleton lines={5} />
      </Card>
    );
  }

  const { meeting, utterances, questions, agent } = detail;
  const isLive = meeting.status === 'live';
  const rehearsal = meeting.kind === 'rehearsal';
  const scheduled = meeting.status === 'scheduled';
  const pending = questions.filter((q) => q.status === 'pending').length;
  const agentLines = utterances.filter((u) => u.is_agent);
  const spokenChars = running ? agentLines.reduce((n, u) => n + u.text.length, 0) : meeting.tts_chars;
  const cap = setup?.limits?.ttsMaxChars;
  const started = parseTs(meeting.created_at).getTime();
  const ended = meeting.ended_at ? parseTs(meeting.ended_at).getTime() : now;
  const act = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e: Error) => setError(e.message));
  };

  function say(e: FormEvent) {
    e.preventDefault();
    const text = sayText.trim();
    if (!text) return;
    setSayText('');
    act(() => api.say(id, text));
  }

  const orbState = !agent ? 'idle' : agent.muted ? 'muted' : agent.state;

  return (
    <>
      <PageHeader
        eyebrow={rehearsal ? 'Rehearsal' : running ? 'Live meeting' : scheduled ? 'Scheduled meeting' : 'Meeting'}
        title={meeting.title || 'Meeting'}
        subtitle={
          <span className="row">
            {running && (
              <span className={`slot-chip slot-${rehearsal ? 'r' : (detail.slot ?? 0) % 6}`}>
                <span className="slot-dot" />
              </span>
            )}
            <StatusBadge status={meeting.status} />
            <span className="muted">
              {parseTs(scheduled && meeting.scheduled_at ? meeting.scheduled_at : meeting.created_at).toLocaleString([], {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </span>
        }
        actions={
          running ? (
            <>
              {isLive && agent && (
                <button
                  className={agent.muted ? 'secondary' : 'danger'}
                  onClick={() => act(() => api.mute(id, !agent.muted))}
                  title="Stops the assistant mid-sentence and keeps it silent"
                >
                  <Icon name={agent.muted ? 'mic' : 'micOff'} />
                  {agent.muted ? 'Unmute' : 'Mute now'}
                </button>
              )}
              <button className="secondary" onClick={() => act(() => api.leave(id))}>
                <Icon name="leave" /> {rehearsal ? 'End rehearsal' : 'Leave'}
              </button>
            </>
          ) : scheduled ? (
            <>
              <button
                className="primary"
                disabled={!setup || slotsUsed(setup) >= setup.maxMeetings}
                title={setup && slotsUsed(setup) >= setup.maxMeetings ? 'Every place is in use. Leave a meeting first.' : undefined}
                onClick={() => act(() => api.startNow(id))}
              >
                Join now
              </button>
              <button className="secondary" onClick={() => act(() => api.cancel(id).then(() => navigate('/history')))}>
                <Icon name="trash" size={16} /> Cancel
              </button>
            </>
          ) : (
            <Link className="button secondary" to="/">
              <Icon name="plus" size={16} /> New meeting
            </Link>
          )
        }
      />

      {meeting.error && <Callout kind="error">{meeting.error}</Callout>}
      {meeting.status === 'ended' && meeting.end_reason && (
        <Callout kind="note">The assistant left because {meeting.end_reason.replace(/^The /, 'the ')}.</Callout>
      )}
      {error && <Callout kind="error">{error}</Callout>}
      {meeting.status === 'starting' && !rehearsal && (
        <Callout kind="note">Opening Teams and joining. This usually takes 15 to 30 seconds.</Callout>
      )}
      {scheduled && meeting.scheduled_at && (
        <Callout kind="note">
          The assistant will join on its own at{' '}
          <strong>
            {parseTs(meeting.scheduled_at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}
          </strong>
          . Keep this computer on and the app running until then.
          {setup?.telegram ? ' You will get a Telegram message a few minutes before.' : ''}
        </Callout>
      )}
      {running && meeting.notify_mode === 'collect' && (
        <Callout kind="note">
          Do not disturb is on for this meeting: questions it cannot answer are collected below and in the summary
          instead of being sent to you on Telegram.
        </Callout>
      )}
      {rehearsal && running && (
        <Callout kind="note">
          This is a rehearsal. Nothing is sent to Teams and no ElevenLabs credits are used. Type what people in the
          meeting would say and see how the assistant responds.
        </Callout>
      )}
      {meeting.status === 'lobby' && (
        <Callout kind="warn">Waiting in the lobby. Someone in the meeting needs to admit the assistant.</Callout>
      )}

      <div className="stats">
        <Stat icon="clock" label="Duration" value={scheduled ? 'Not started' : formatDuration(ended - started)} />
        <Stat icon="chat" label="Transcript lines" value={utterances.length} />
        <Stat icon="info" label="Open questions" value={pending} />
        <Stat
          icon="coins"
          label={rehearsal ? 'Voice it would use' : 'Voice used'}
          value={`${spokenChars.toLocaleString()}${cap ? ` / ${cap.toLocaleString()}` : ''}`}
          hint={rehearsal ? 'characters, none spent' : 'characters'}
        />
      </div>

      <div className="split wide-main">
        <div className="stack">
          {meeting.summary && (
            <Card title="Summary" icon="file">
              <pre className="summary">{meeting.summary}</pre>
            </Card>
          )}

          <Card
            title="Transcript"
            icon="chat"
            action={running && <span className="tag live-tag"><span className="dot" /> Live</span>}
          >
            <div className="transcript">
              {utterances.length === 0 && !partial && (
                <div className="empty-state compact">
                  <Icon name="wave" size={24} />
                  <p>
                    {scheduled
                      ? 'The transcript will appear here once the meeting starts.'
                      : rehearsal && running
                        ? 'Type a line below to start, for example "Any update from your side?"'
                        : running
                          ? 'Nothing has been said yet.'
                          : 'Nothing was said.'}
                  </p>
                </div>
              )}
              {utterances.map((u) => (
                <div key={u.id} className={u.is_agent ? 'line agent' : 'line'}>
                  <span
                    className="avatar"
                    style={u.is_agent ? undefined : ({ '--hue': speakerHue(u.speaker) } as CSSProperties)}
                  >
                    {u.is_agent ? <Icon name="wave" size={16} /> : initials(u.speaker)}
                  </span>
                  <div>
                    <p className="line-head">
                      <strong>{u.is_agent ? 'Your assistant' : u.speaker}</strong>
                      {Boolean(u.is_agent) && <span className="tag">AI</span>}
                      <span className="muted">{time(u.ts)}</span>
                    </p>
                    <p>{u.text}</p>
                  </div>
                </div>
              ))}
              {partial && (
                <div className="line partial">
                  <span className="avatar typing">
                    <i /><i /><i />
                  </span>
                  <div>
                    <p>{partial}</p>
                  </div>
                </div>
              )}
              <div ref={transcriptEnd} />
            </div>
          </Card>

          {rehearsal && isLive && <ParticipantBox id={id} onError={setError} />}
        </div>

        <aside className="side">
          {isLive && agent && (
            <Card className="agent-card">
              <div className={`orb-wrap ${orbState}`}>
                <div className="orb" aria-hidden="true">
                  <span /><span />
                </div>
                <div>
                  <h2 className="plain">{agent.muted ? 'Muted by you' : AGENT_TEXT[agent.state][0]}</h2>
                  <p className="muted small">
                    {agent.muted
                      ? 'It stays silent until you unmute'
                      : rehearsal && agent.state === 'speaking'
                        ? 'As text only in a rehearsal'
                        : AGENT_TEXT[agent.state][1]}
                  </p>
                </div>
              </div>
              <form className="say" onSubmit={say}>
                <textarea
                  rows={3}
                  placeholder="Type something for it to say at the next gap"
                  value={sayText}
                  onChange={(e) => setSayText(e.target.value)}
                  disabled={agent.muted}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) say(e);
                  }}
                />
                <div className="say-foot">
                  <span className="muted small">
                    Enter to send · {rehearsal ? 'shown as text' : 'spoken in your voice'}
                  </span>
                  <button type="submit" className="primary small" disabled={agent.muted || !sayText.trim()}>
                    <Icon name="send" size={15} /> Say
                  </button>
                </div>
              </form>
            </Card>
          )}

          <Card
            title="Questions for you"
            icon="info"
            action={pending > 0 && <span className="count">{pending}</span>}
          >
            {questions.length === 0 ? (
              <p className="muted small">
                {running || scheduled
                  ? 'Anything the assistant cannot answer will appear here.'
                  : 'No questions were passed on.'}
              </p>
            ) : (
              questions.map((q) => <QuestionRow key={q.id} q={q} canSpeak={isLive} onError={setError} />)
            )}
          </Card>

          {!running && !scheduled && !rehearsal && (
            <Card title="Usage" icon="coins">
              <dl className="kv">
                <div>
                  <dt>Transcribed</dt>
                  <dd>{meeting.stt_seconds > 0 ? `${(meeting.stt_seconds / 60).toFixed(1)} min` : 'None (free captions)'}</dd>
                </div>
                <div>
                  <dt>Spoken</dt>
                  <dd>{meeting.tts_chars.toLocaleString()} characters</dd>
                </div>
                {meeting.ram_peak_mb != null && (
                  <div>
                    <dt>Browser memory</dt>
                    <dd>
                      peak {Math.round(meeting.ram_peak_mb)} MB · average {Math.round(meeting.ram_avg_mb ?? 0)} MB
                    </dd>
                  </div>
                )}
                {meeting.cpu_avg != null && (
                  <div>
                    <dt>Browser CPU</dt>
                    <dd>{meeting.cpu_avg.toFixed(2)} cores on average</dd>
                  </div>
                )}
              </dl>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

/** Rehearsal only: the owner plays the other people in the meeting. */
function ParticipantBox({ id, onError }: { id: number; onError: (m: string) => void }) {
  const [speaker, setSpeaker] = useState('Alex');
  const [text, setText] = useState('');

  function send(e: FormEvent) {
    e.preventDefault();
    const line = text.trim();
    if (!line) return;
    setText('');
    onError('');
    api.hear(id, speaker, line).catch((err: Error) => onError(err.message));
  }

  return (
    <Card title="Speak as a participant" icon="users">
      <form className="say" onSubmit={send}>
        <div className="hear-row">
          <input
            aria-label="Participant name"
            placeholder="Name"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
          />
          <textarea
            rows={2}
            aria-label="What they say"
            placeholder="What they say, e.g. Any update from your side?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send(e);
            }}
          />
        </div>
        <div className="say-foot">
          <button
            type="button"
            className="ghost small"
            title="Pretend nobody has spoken for 20 seconds, which is when the assistant offers the update unasked"
            onClick={() => {
              onError('');
              api.lull(id).catch((err: Error) => onError(err.message));
            }}
          >
            <Icon name="clock" size={15} /> Simulate a quiet room
          </button>
          <button type="submit" className="primary small" disabled={!text.trim()}>
            <Icon name="send" size={15} /> Say it
          </button>
        </div>
      </form>
    </Card>
  );
}

function QuestionRow({ q, canSpeak, onError }: { q: Question; canSpeak: boolean; onError: (m: string) => void }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await api.answer(q.id, answer.trim());
    } catch (err) {
      onError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className={`question ${q.status}`}>
      <p className="line-head">
        <strong>{q.asker}</strong>
        <span className="muted">{time(q.ts)}</span>
      </p>
      <p>{q.question}</p>
      {q.status === 'pending' ? (
        <form className="say" onSubmit={submit}>
          <textarea
            rows={2}
            placeholder={canSpeak ? 'Your answer, spoken in the meeting' : 'Your answer (the meeting is over)'}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="say-foot">
            <span />
            <button type="submit" className="primary small" disabled={busy || !answer.trim()}>
              {canSpeak ? 'Answer' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <p className="answer">
          <Icon name="check" size={14} />
          <span>
            {q.answer}{' '}
            <span className="muted">{q.status === 'relayed' ? '· passed on in the meeting' : '· not spoken'}</span>
          </span>
        </p>
      )}
    </div>
  );
}
