import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Meeting } from '../lib/api';
import { Callout, Card, Icon, PageHeader, parseTs, Skeleton, Stat, StatusBadge } from '../ui';

function minutes(m: Meeting): number {
  if (!m.ended_at) return 0;
  return Math.max(0, (parseTs(m.ended_at).getTime() - parseTs(m.created_at).getTime()) / 60_000);
}

function durationText(m: Meeting): string {
  if (!m.ended_at) return '';
  const mins = Math.round(minutes(m));
  return mins < 1 ? 'under a minute' : `${mins} min`;
}

export function History() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    api
      .meetings()
      .then(setMeetings)
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = useMemo(
    () => (meetings ?? []).filter((m) => (m.title || 'Meeting').toLowerCase().includes(query.trim().toLowerCase())),
    [meetings, query],
  );
  // Rehearsals are practice: they are listed, but not counted as meetings or as voice spent.
  const real = (meetings ?? []).filter((m) => m.kind !== 'rehearsal');
  const attended = real.filter((m) => m.status === 'ended');
  const totalMinutes = Math.round(attended.reduce((n, m) => n + minutes(m), 0));
  const totalChars = real.reduce((n, m) => n + m.tts_chars, 0);

  return (
    <>
      <PageHeader
        eyebrow="History"
        title="Meetings"
        subtitle="Scheduled meetings, rehearsals, and transcripts and summaries of every meeting your assistant attended."
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
            <Icon name="clock" size={26} />
          </span>
          <strong>No meetings yet</strong>
          <p className="muted">Once the assistant has attended a meeting, it will be listed here.</p>
          <Link className="button primary" to="/">
            Send it to a meeting
          </Link>
        </Card>
      )}

      {meetings && meetings.length > 0 && (
        <>
          <div className="stats three">
            <Stat icon="users" label="Meetings attended" value={attended.length} />
            <Stat icon="clock" label="Time in meetings" value={`${totalMinutes} min`} />
            <Stat icon="coins" label="Voice used" value={totalChars.toLocaleString()} hint="characters" />
          </div>

          <Card className="flush">
            <div className="list-toolbar">
              <span className="input-group">
                <Icon name="search" />
                <input
                  type="search"
                  placeholder="Search meetings"
                  aria-label="Search meetings"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
              <span className="muted small">
                {shown.length} of {meetings.length}
              </span>
            </div>
            {shown.length === 0 ? (
              <p className="muted list-empty">No meetings match "{query}".</p>
            ) : (
              <ul className="history">
                {shown.map((m) => (
                  <li key={m.id}>
                    <Link to={`/meetings/${m.id}`}>
                      <span className="history-icon">
                        <Icon
                          name={m.kind === 'rehearsal' ? 'flask' : m.status === 'scheduled' ? 'calendar' : 'users'}
                          size={18}
                        />
                      </span>
                      <div className="history-main">
                        <strong>{m.title || 'Meeting'}</strong>
                        <span className="muted">
                          {m.status === 'scheduled' && m.scheduled_at
                            ? `Joins ${parseTs(m.scheduled_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
                            : parseTs(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                          {m.kind === 'rehearsal' ? ' · rehearsal' : ''}
                          {durationText(m) && ` · ${durationText(m)}`}
                          {m.summary ? ' · summary available' : ''}
                        </span>
                      </div>
                      <StatusBadge status={m.status} />
                      <Icon name="chevron" size={16} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
