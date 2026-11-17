import { useEffect, useState, type ReactNode } from 'react';
import type { MeetingStatus } from './lib/api';

const PATHS = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M3 3l18 18M9 9v3a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.6 2.8M12 18v3',
  leave: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  send: 'M4 12l16-8-6 16-3-7-7-1Z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 11v6M12 7.5v.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  chevron: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  wave: 'M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4',
  chat: 'M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12Z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.200l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8.500 8.500 0 0 1 9.500 4a7 7 0 1 0 10.500 10.500Z',
  monitor: 'M4 5h16v11H4zM9 20h6M12 16v4',
  link: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  shield: 'M12 3l7 3v5c0 4.500-3 8.500-7 10-4-1.500-7-5.500-7-10V6l7-3ZM9 12l2 2 4-4',
  search: 'M20 20l-4-4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  clipboard: 'M9 4h6v3H9zM9 5.500H6V20h12V5.500h-3',
  coins: 'M4 7c0-1.700 3-3 7-3s7 1.300 7 3-3 3-7 3-7-1.300-7-3ZM4 7v5c0 1.700 3 3 7 3s7-1.300 7-3V7M4 12v5c0 1.700 3 3 7 3s7-1.300 7-3v-5',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.500 10a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7ZM21 19v-1a4 4 0 0 0-3-3.900M15.500 3.200a3.500 3.500 0 0 1 0 6.700',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4',
  flask: 'M10 3h4M10.500 3v6L5 19a1.500 1.500 0 0 0 1.300 2h11.400A1.500 1.500 0 0 0 19 19l-5.500-10V3M8 15h8',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <defs>
        <linearGradient id="ab-logo" x1="0" y1="0" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="30" height="30" rx="9" fill="url(#ab-logo)" />
      <path d="M8 13v4M11.500 10v10M15 12.500v5M18.500 8.500v13M22 13v4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---- Theme ------------------------------------------------------------------

export type ThemePref = 'light' | 'dark' | 'system';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('ab-theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return 'system';
}

function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Light / Dark / System switch. The choice is remembered in this browser. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(readPref);

  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem('ab-theme', pref);
    } catch {}
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const options: { value: ThemePref; icon: IconName; label: string }[] = [
    { value: 'light', icon: 'sun', label: 'Light' },
    { value: 'dark', icon: 'moon', label: 'Dark' },
    { value: 'system', icon: 'monitor', label: 'System' },
  ];
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          aria-label={`${o.label} theme`}
          title={`${o.label} theme`}
          className={pref === o.value ? 'on' : ''}
          onClick={() => setPref(o.value)}
        >
          <Icon name={o.icon} size={15} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---- Building blocks --------------------------------------------------------

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  starting: 'Joining',
  lobby: 'In lobby',
  live: 'Live',
  ended: 'Ended',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: MeetingStatus }) {
  const running = status === 'starting' || status === 'lobby' || status === 'live';
  return (
    <span className={`badge ${status}`}>
      {running && <span className="dot" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A labelled form field with an optional hint line. */
export function Field({
  label,
  optional,
  hint,
  aside,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: string;
  /** Shown at the right end of the label row, e.g. a character count. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {optional && <span className="optional">Optional</span>}
        {aside && <span className="field-aside">{aside}</span>}
      </span>
      {hint && <span className="field-hint">{hint}</span>}
      {children}
    </label>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  icon,
  action,
  className = '',
  children,
}: {
  title?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h2>
            {icon && <Icon name={icon} size={16} />}
            {title}
          </h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, icon, hint }: { label: string; value: ReactNode; icon: IconName; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-icon">
        <Icon name={icon} size={16} />
      </span>
      <div>
        <p className="stat-label">{label}</p>
        <p className="stat-value">{value}</p>
        {hint && <p className="stat-hint">{hint}</p>}
      </div>
    </div>
  );
}

export function Callout({ kind, children }: { kind: 'error' | 'warn' | 'note' | 'ok'; children: ReactNode }) {
  return (
    <div className={`callout ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon name={kind === 'ok' ? 'check' : kind === 'note' ? 'info' : 'alert'} />
      <div>{children}</div>
    </div>
  );
}

/** Circular progress, e.g. "3 of 4 set up". */
export function Ring({ done, total }: { done: number; total: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${done === total ? 'full' : ''}`} width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r={r} className="ring-track" />
      <circle
        cx="26"
        cy="26"
        r={r}
        className="ring-fill"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - done / Math.max(1, total))}
        transform="rotate(-90 26 26)"
      />
      <text x="26" y="30" textAnchor="middle">
        {done}/{total}
      </text>
    </svg>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${90 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** "2026-11-10 11:30:00" (UTC, as SQLite stores it) to a local Date. */
export function parseTs(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** A steady colour per speaker so people are easy to tell apart. */
export function speakerHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
