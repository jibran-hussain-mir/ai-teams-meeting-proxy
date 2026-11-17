import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, slotsUsed, type Meeting, type Setup } from '../lib/api';
import { Callout, Card, Field, Icon, PageHeader, parseTs } from '../ui';

/** A Date in the form a datetime-local input uses (local time, to the minute). */
function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STEPS: [string, string][] = [
  ['Joins as a guest', 'Under a name that says it is your AI assistant. It says so aloud the first time it speaks.'],
  ['Gives your update', 'When someone asks for it, or when the room goes quiet, in your voice.'],
  ['Answers from your notes', 'Only facts you provided. It never guesses or commits you to anything.'],
  ['Asks you the rest', 'Unknown questions reach you on Telegram and here. Your reply is spoken in the meeting.'],
  ['Several at once', 'Send it to overlapping meetings and attend the important one yourself. Each is colour-coded.'],
];

/** Roughly how long text takes to say aloud. */
function speechTime(chars: number): string {
  const seconds = Math.round(chars / 15);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function NewMeeting({ setup }: { setup: Setup | null }) {
  const navigate = useNavigate();
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [update, setUpdate] = useState('');
  const [context, setContext] = useState('');
  const [doNotDiscuss, setDoNotDiscuss] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [startAt, setStartAt] = useState('');
  const [notifyMode, setNotifyMode] = useState<'live' | 'collect'>('live');
  const [upcoming, setUpcoming] = useState<Meeting[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .meetings()
      .then((all) =>
        setUpcoming(
          all
            .filter((m) => m.status === 'scheduled' && m.scheduled_at)
            .sort((a, b) => a.scheduled_at!.localeCompare(b.scheduled_at!)),
        ),
      )
      .catch(() => {});
  }, []);

  const used = slotsUsed(setup);
  const max = setup?.maxMeetings ?? 1;
  const full = used >= max;
  // A meeting for later can be set up while every place is taken; joining now cannot.
  const blocked = !setup || setup.missing.length > 0 || (full && !startAt);
  const cap = setup?.limits?.ttsMaxChars;
  const overCap = cap !== undefined && update.length > cap;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const meeting = await api.createMeeting({
        link,
        title,
        update,
        context,
        doNotDiscuss,
        notifyMode,
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
      });
      navigate(`/meetings/${meeting.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  /** Practice run: same update and notes, but nothing joins Teams. */
  async function rehearse() {
    setBusy(true);
    setError('');
    try {
      const meeting = await api.createMeeting({
        link: '',
        title,
        update,
        context,
        doNotDiscuss,
        notifyMode,
        rehearsal: true,
      });
      navigate(`/meetings/${meeting.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) setLink(text);
    } catch {
      setError('The browser blocked clipboard access. Paste the link with Ctrl+V instead.');
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError('');
    for (const file of Array.from(files)) {
      try {
        const { name, text } = await api.extract(file);
        setContext((c) => `${c}${c.trim() ? '\n\n' : ''}--- ${name} ---\n${text}`);
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <>
      <PageHeader
        eyebrow="New meeting"
        title="Send your assistant to a meeting"
        subtitle={
          <>
            It joins as <strong>{setup?.botName ?? 'your AI assistant'}</strong> and speaks on your behalf.
          </>
        }
      />
      <div className="split">
        <form className="card composer" onSubmit={submit}>
          <section className="step">
            <span className="step-no">1</span>
            <div className="step-body">
              <h2 className="plain">Meeting</h2>
              <Field label="Teams meeting link">
                <span className="input-group">
                  <Icon name="link" />
                  <input
                    type="url"
                    required
                    placeholder="https://teams.microsoft.com/l/meetup-join/…"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                  />
                  <button type="button" className="ghost small" onClick={() => void paste()}>
                    <Icon name="clipboard" size={15} /> Paste
                  </button>
                </span>
              </Field>
              <Field label="Meeting name" optional>
                <input placeholder="Weekly platform sync" value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field
                label="Join at"
                optional
                hint="Leave empty to join now. For a later time, this computer must be on with the app running."
              >
                <input
                  type="datetime-local"
                  value={startAt}
                  min={localInputValue(new Date())}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </Field>
            </div>
          </section>

          <section className="step">
            <span className="step-no">2</span>
            <div className="step-body">
              <h2 className="plain">What to say</h2>
              <Field
                label="Your update"
                hint="Write it the way you would say it out loud."
                aside={
                  update.length > 0 && (
                    <span className={overCap ? 'over' : ''}>
                      {update.length.toLocaleString()} characters · about {speechTime(update.length)}
                    </span>
                  )
                }
              >
                <textarea
                  rows={5}
                  placeholder="The payments migration is finished and live since Tuesday…"
                  value={update}
                  onChange={(e) => setUpdate(e.target.value)}
                />
              </Field>
              {overCap && (
                <Callout kind="warn">
                  This is longer than the voice limit of {cap!.toLocaleString()} characters per meeting, so part of it
                  would be posted in the chat instead of spoken.
                </Callout>
              )}
              <Field
                label="Background for questions"
                optional
                hint="Facts the assistant may use: dates, numbers, who is doing what, decisions already made."
              >
                <textarea rows={6} value={context} onChange={(e) => setContext(e.target.value)} />
              </Field>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.pdf,.csv,.json,.log"
                hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
              <button type="button" className="secondary small" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={15} /> Add from file
                <span className="muted">.txt .md .pdf</span>
              </button>
            </div>
          </section>

          <section className="step">
            <span className="step-no">3</span>
            <div className="step-body">
              <h2 className="plain">Guardrails</h2>
              <Field
                label="Do not discuss"
                optional
                hint="If asked about these, it says you will follow up yourself and lets you know."
              >
                <textarea rows={2} value={doNotDiscuss} onChange={(e) => setDoNotDiscuss(e.target.value)} />
              </Field>
              <div className="field">
                <span className="field-label">When it cannot answer a question</span>
                <div className="choice" role="radiogroup" aria-label="When it cannot answer a question">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={notifyMode === 'live'}
                    className={notifyMode === 'live' ? 'on' : ''}
                    onClick={() => setNotifyMode('live')}
                  >
                    <strong>Ask me live</strong>
                    <span>You get the question on Telegram and here. Your reply is spoken in the meeting.</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={notifyMode === 'collect'}
                    className={notifyMode === 'collect' ? 'on' : ''}
                    onClick={() => setNotifyMode('collect')}
                  >
                    <strong>Do not disturb me</strong>
                    <span>For when you are in another meeting. It says you will follow up, and questions come with the summary.</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {error && <Callout kind="error">{error}</Callout>}
          {setup && setup.missing.length > 0 && (
            <Callout kind="warn">
              To join a real meeting, set these in <code>.env</code> and restart: {setup.missing.join(', ')}. You can
              still rehearse.
            </Callout>
          )}
          {full && (
            <Callout kind="note">
              The assistant is already in {used} meeting{used === 1 ? '' : 's'}, which is the limit. You can still
              schedule one for later or rehearse. <Link to="/live">See what is running</Link>
            </Callout>
          )}
          <div className="composer-foot">
            <button type="submit" className="primary large" disabled={busy || blocked}>
              {startAt ? <Icon name="calendar" size={16} /> : null}
              {busy ? 'Working…' : startAt ? 'Schedule meeting' : 'Join meeting'}
              {!busy && !startAt && <Icon name="chevron" size={16} />}
            </button>
            <button
              type="button"
              className="secondary large"
              disabled={busy || !setup}
              onClick={() => void rehearse()}
              title="Practise in this app: no Teams, no ElevenLabs credits"
            >
              <Icon name="flask" size={16} /> Rehearse first
            </button>
            {setup && setup.missing.length === 0 && (
              <span className="muted small">
                {used} of {max} meeting places in use
              </span>
            )}
          </div>
          <p className="field-hint">
            A rehearsal is a text-only practice run. You type what people would say and see how the assistant answers.
            It does not join Teams and uses no ElevenLabs credits.
          </p>
        </form>

        <aside className="side">
          {upcoming.length > 0 && (
            <Card title="Upcoming" icon="calendar">
              <ul className="upcoming">
                {upcoming.map((m) => (
                  <li key={m.id}>
                    <Link to={`/meetings/${m.id}`}>
                      <strong>{m.title || 'Meeting'}</strong>
                      <span className="muted small">
                        {parseTs(m.scheduled_at!).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {setup?.limits && (
            <Card title="Credit saver" icon="coins">
              <dl className="kv">
                <div>
                  <dt>Listening</dt>
                  <dd>
                    {setup.limits.sttMode === 'captions' ? (
                      <>
                        Teams captions <span className="tag ok">Free</span>
                      </>
                    ) : (
                      <>
                        ElevenLabs <span className="tag">max {setup.limits.sttMaxMinutes} min</span>
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Voice per meeting</dt>
                  <dd>{setup.limits.ttsMaxChars.toLocaleString()} characters</dd>
                </div>
                <div>
                  <dt>Voice today, all meetings</dt>
                  <dd>
                    {setup.limits.ttsSpentToday.toLocaleString()} / {setup.limits.ttsDailyMaxChars.toLocaleString()}
                  </dd>
                </div>
              </dl>
              <p className="muted small">Past either voice limit, replies are posted in the meeting chat.</p>
            </Card>
          )}

          <Card title="How it works" icon="info">
            <ol className="steps">
              {STEPS.map(([head, body]) => (
                <li key={head}>
                  <strong>{head}</strong>
                  <span>{body}</span>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </>
  );
}
