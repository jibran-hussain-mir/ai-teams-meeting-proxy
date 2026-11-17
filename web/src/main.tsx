import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/inter';
import { api, slotsUsed, type Setup } from './lib/api';
import { NewMeeting } from './pages/NewMeeting';
import { Overview } from './pages/Overview';
import { MeetingPage } from './pages/Live';
import { History } from './pages/History';
import { VoiceSetup } from './pages/VoiceSetup';
import { Callout, Icon, Logo, STATUS_LABEL, ThemeToggle, type IconName } from './ui';
import './styles.css';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'New meeting', icon: 'plus', end: true },
  { to: '/live', label: 'Live', icon: 'wave' },
  { to: '/history', label: 'History', icon: 'clock' },
  { to: '/voice', label: 'Voice', icon: 'mic' },
];

function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const refresh = () =>
    api
      .setup()
      .then((s) => {
        setSetup(s);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);
  const active = setup?.activeMeetings ?? [];

  return (
    <BrowserRouter>
      <div className="app">
        <aside className="sidebar">
          <Link to="/" className="brand">
            <Logo />
            <span>
              Proxy
              <small>Attends meetings for you</small>
            </span>
          </Link>

          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {n.to === '/live' && active.length > 0 && <span className="count">{active.length}</span>}
              </NavLink>
            ))}
          </nav>

          {active.length > 0 && (
            <section className="live-list" aria-label="Meetings in progress">
              <p className="live-list-head">
                <span>Attending now</span>
                {/* Rehearsals do not take up places, so the count is shown only for real meetings. */}
                {slotsUsed(setup) > 0 && (
                  <span>
                    {slotsUsed(setup)} of {setup!.maxMeetings}
                  </span>
                )}
              </p>
              {active.map((m) => (
                <NavLink key={m.id} to={`/meetings/${m.id}`} className={`live-item slot-${m.kind === 'rehearsal' ? 'r' : m.slot % 6}`}>
                  <span className="slot-dot" />
                  <span className="live-item-main">
                    <strong>{m.title || 'Meeting'}</strong>
                    <small>
                      {m.kind === 'rehearsal' ? 'Rehearsal' : STATUS_LABEL[m.status]}
                      {m.pending > 0 && ` · ${m.pending} question${m.pending === 1 ? '' : 's'}`}
                    </small>
                  </span>
                  {m.pending > 0 && <span className="count">{m.pending}</span>}
                </NavLink>
              ))}
            </section>
          )}

          <div className="sidebar-foot">
            <ThemeToggle />
            <p className="fineprint">
              <Icon name="shield" size={14} /> Runs locally on this computer
            </p>
          </div>
        </aside>

        <main>
          {error && <Callout kind="error">{error}</Callout>}
          <Routes>
            <Route path="/" element={<NewMeeting setup={setup} />} />
            <Route path="/live" element={<Overview setup={setup} onChange={refresh} />} />
            <Route path="/meetings/:id" element={<MeetingPage setup={setup} onChange={refresh} />} />
            <Route path="/history" element={<History />} />
            <Route path="/voice" element={<VoiceSetup setup={setup} onChange={refresh} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
