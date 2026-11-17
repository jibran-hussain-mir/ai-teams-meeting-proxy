import { describe, expect, it } from 'vitest';
import { withoutAppLaunch } from '../src/bot/teams.js';

describe('withoutAppLaunch', () => {
  it('tells the Teams launcher not to open the desktop app', () => {
    const out = withoutAppLaunch(
      'https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F123%3Fp%3Dabc&type=meet&directDl=true&msLaunch=true',
    );
    const u = new URL(out!);
    expect(u.searchParams.get('msLaunch')).toBe('false');
    expect(u.searchParams.get('suppressPrompt')).toBe('true');
    // Everything else is kept, including where to go next.
    expect(u.searchParams.get('url')).toBe('/_#/meet/123?p=abc');
    expect(u.searchParams.get('type')).toBe('meet');
  });

  it('works for work and school links too', () => {
    const out = withoutAppLaunch('https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2Fx&type=meetup-join');
    expect(new URL(out!).searchParams.get('msLaunch')).toBe('false');
  });

  it('leaves other pages, and already-fixed launcher pages, alone', () => {
    expect(withoutAppLaunch('https://teams.live.com/meet/123?p=abc')).toBeNull();
    expect(withoutAppLaunch('https://teams.live.com/v2/')).toBeNull();
    expect(withoutAppLaunch('https://teams.live.com/dl/launcher/launcher.html?msLaunch=false')).toBeNull();
    expect(withoutAppLaunch('not a url')).toBeNull();
  });
});
