import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, slotsUsed, subscribe, type AgentState, type LiveMeeting, type Question, type Setup } from '../lib/api';
import { Callout, Card, formatDuration, Icon, PageHeader, parseTs, Skeleton, StatusBadge } from '../ui';

const AGENT_LABEL: Record<AgentState, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  waiting: 'Waiting for a gap',
  speaking: 'Speaking',
};

/** Every meeting the assistant is in right now, on one screen. */
export function Overview({ setup, onChange }: { setup: Setup | null; onChange: () => void }) {
  const [meetings, setMeetings] = useState<LiveMeeting[] | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const count = useRef(-1);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api
        .live()
        .then((list) => {
          setMeetings(list);
          // A meeting started or ended: the sidebar needs to know too.
          if (count.current !== -1 && count.current !== list.length) onChange();
          count.current = list.length;
        })
        .catch((e: Error) => setError(e.message));
    void load();
    // Anything happening in any meeting refreshes the page, at most a few times a second.
    const stop = subscribe((e) => {
      if (e.type === 'partial' || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 250);
    }, load);
    const poll = setInterval(load, 8000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop();
      clearInterval(poll);
      clearInterval(clock);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const act = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e: Error) => setError(e.message));
  };
  const questions = (meetings ?? []).reduce((n, m) => n + m.questions.length, 0);

  return (
    <>
      <PageHeader
        eyebrow="Live"
        title="Meetings in progress"
        subtitle={
          meetings && meetings.length > 0
            ? `${meetings.length} running${slotsUsed(setup) ? ` · ${slotsUsed(setup)} of ${setup?.maxMeetings ?? '…'} meeting places in use` : ''}${questions ? ` · ${questions} question${questions === 1 ? '' : 's'} waiting for you` : ''}`
            : 'Everything your assistant is attending right now, on one screen.'
        }
        actions={
          <Link className="button primary" to="/">
            <Icon name="plus" size={16} /> New meeting
          </Link>
        }
      />
      {error && <Callout kind="error">{error}</Callout>}
      {!meetings && !error && (
        <Card>
          <Skeleton lines={4} />
        </Card>
      )}

      {meetings && meetings.length === 0 && (
        <Card className="empty-state">
          <span className="empty-icon">
            <Icon name="wave" size={26} />
          </span>
          <strong>Nothing running</strong>
          <p className="muted">
            The assistant can attend up to {setup?.maxMeetings ?? 3} meetings at the same time. Each one appears here
            while it is in progress.
          </p>
          <Link className="button primary" to="/">
            Send it to a meeting
          </Link>
        </Card>
      )}

      {meetings && meetings.length > 0 && (
        <div className="live-grid">
          {meetings.map((m) => {
            const { meeting, agent } = m;
            const rehearsal = meeting.kind === 'rehearsal';
            const isLive = meeting.status === 'live';
            const orb = agent.muted ? 'muted' : agent.state;
            return (
              <section key={meeting.id} className={`card live-tile slot-${rehearsal ? 'r' : m.slot % 6}`}>
                <header className="live-tile-head">
                  <span className="slot-dot" />
                  <div className="live-tile-title">
                    <Link to={`/meetings/${meeting.id}`}>
                      <h2 className="plain">{meeting.title || 'Meeting'}</h2>
                    </Link>
                    <p className="muted small">
                      {rehearsal ? 'Rehearsal · ' : ''}
                      {formatDuration(now - parseTs(meeting.created_at).getTime())} · {m.lines} line
                      {m.lines === 1 ? '' : 's'}
                      {m.resources && ` · ${Math.round(m.resources.memMb)} MB`}
                    </p>
                  </div>
                  <StatusBadge status={meeting.status} />
                </header>

                {isLive && (
                  <div className={`orb-wrap small ${orb}`}>
                    <div className="orb" aria-hidden="true">
                      <span /><span />
                    </div>
                    <strong>{agent.muted ? 'Muted by you' : AGENT_LABEL[agent.state]}</strong>
                  </div>
                )}
                {meeting.status === 'lobby' && (
                  <p className="muted small">Waiting in the lobby. Someone in the meeting needs to admit the assistant.</p>
                )}
                {meeting.status === 'starting' && !rehearsal && <p className="muted small">Opening Teams and joining…</p>}

                <div className="live-tile-lines">
                  {m.recent.length === 0 ? (
                    <p className="muted small">Nothing has been said yet.</p>
                  ) : (
                    m.recent.map((u) => (
                      <p key={u.id} className={u.is_agent ? 'agent' : ''}>
                        <strong>{u.is_agent ? 'Assistant' : u.speaker}</strong> {u.text}
                      </p>
                    ))
                  )}
                </div>

                {m.questions.map((q) => (
                  <QuickAnswer key={q.id} q={q} onError={setError} />
                ))}

                <footer className="live-tile-foot">
                  <Link className="button secondary small" to={`/meetings/${meeting.id}`}>
                    Open <Icon name="chevron" size={14} />
                  </Link>
                  <span className="spacer" />
                  {isLive && (
                    <button
                      className={agent.muted ? 'secondary small' : 'danger small'}
                      onClick={() => act(() => api.mute(meeting.id, !agent.muted))}
                    >
                      <Icon name={agent.muted ? 'mic' : 'micOff'} size={15} />
                      {agent.muted ? 'Unmute' : 'Mute'}
                    </button>
                  )}
                  <button className="secondary small" onClick={() => act(() => api.leave(meeting.id))}>
                    <Icon name="leave" size={15} /> {rehearsal ? 'End' : 'Leave'}
                  </button>
                </footer>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/** A waiting question, answerable without leaving the overview. */
function QuickAnswer({ q, onError }: { q: Question; onError: (m: string) => void }) {
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
    <form className="quick-answer" onSubmit={submit}>
      <p>
        <Icon name="info" size={14} /> <strong>{q.asker || 'Someone'}</strong> asks: {q.question}
      </p>
      <div className="row">
        <input
          placeholder="Your answer, spoken in the meeting"
          aria-label={`Answer to ${q.asker || 'someone'}`}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button type="submit" className="primary small" disabled={busy || !answer.trim()}>
          Answer
        </button>
      </div>
    </form>
  );
}
