// Every Teams web-client selector lives here. When Microsoft changes the UI
// and the bot stops finding a button, this is the only file to fix.
// Each entry is a list of candidates tried in order; the first visible wins.

export const SEL = {
  /** Launcher page shown before the web client: "Continue on this browser". */
  continueInBrowser: [
    'button[data-tid="joinOnWeb"]',
    'button:has-text("Continue on this browser")',
    'a:has-text("Continue on this browser")',
    'button:has-text("Join on the web instead")',
  ],
  /** Pre-join screen. */
  nameInput: [
    'input[data-tid="prejoin-display-name-input"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
  ],
  joinNow: [
    'button[data-tid="prejoin-join-button"]',
    '#prejoin-join-button',
    'button:has-text("Join now")',
  ],
  prejoinCameraToggle: [
    '[data-tid="toggle-video"]',
    'input[role="switch"][aria-label*="camera" i]',
    'input[role="switch"][title*="camera" i]',
    '[role="switch"][aria-label*="video" i]',
  ],
  prejoinMicToggle: [
    '[data-tid="toggle-mute"]',
    'input[role="switch"][aria-label*="mic" i]',
    'input[role="switch"][title*="mic" i]',
  ],
  /** In the meeting. Its presence is how we know we are in. */
  hangup: [
    '#hangup-button',
    'button[data-tid="hangup-main-btn"]',
    'button[aria-label="Leave"]',
    'button[aria-label^="Leave"]',
  ],
  micButton: ['#microphone-button', 'button[data-tid="microphone-button"]', 'button[aria-label*="mute" i]'],
  raiseHand: ['#raisehands-button', 'button[data-tid="raisehands-button"]', 'button[aria-label*="raise" i]'],
  moreButton: ['#callingButtons-showMoreBtn', 'button[data-tid="callingButtons-showMoreBtn"]', 'button[aria-label="More"]'],
  /** Under More: the menu that contains captions (newer builds nest it). */
  languageAndSpeech: [
    '#LanguageSpeechMenuControl-id',
    '[role="menuitem"]:has-text("Language and speech")',
    '[role="menuitem"]:has-text("Captions")',
  ],
  captionsToggle: [
    '#closed-captions-button',
    '[role="menuitem"]:has-text("Show live captions")',
    '[role="menuitemcheckbox"]:has-text("live captions")',
    '[role="menuitem"]:has-text("Turn on live captions")',
  ],
  chatButton: ['#chat-button', 'button[data-tid="chat-button"]', 'button[aria-label*="chat" i]'],
  chatInput: ['[data-tid="ckeditor"]', 'div[role="textbox"][contenteditable="true"]'],
  chatSend: ['button[data-tid="newMessageCommands-send"]', 'button[name="send"]', 'button[aria-label="Send"]'],
} as const;

/** Text that means we are waiting to be admitted. */
export const LOBBY_TEXT = [
  /someone (in the meeting )?(will|should) let you in/i,
  /we('ve| have) let (them|people) know you('re| are) (here|waiting)/i,
  /waiting (for|in) (the )?(lobby|others|someone)/i,
  /when the meeting starts, we('ll| will) let/i,
];

/** Text that means we will not get in. */
export const DENIED_TEXT = [
  /denied access/i,
  /you can('|no)t join this meeting/i,
  /no one (let you in|responded)/i,
  /sign in to join/i,
  /only people (who|that) (were|are) invited/i,
];

/** Text that means the meeting is over for us. */
export const ENDED_TEXT = [
  /you('ve| have) been removed/i,
  /the meeting has ended/i,
  /meeting ended/i,
  /you left the meeting/i,
];

/**
 * Runs in the page: how many people are in the meeting, counting the assistant.
 * Read from the number Teams shows on the People button. Returns:
 *   a number  when the button shows one (or the page says nobody else is here: 1),
 *   0         when the button is there but shows no number,
 *   null      when the button cannot be found, so nothing can be said.
 */
export const PARTICIPANTS_JS = `(() => {
  const btn = document.querySelector('#roster-button, button[data-tid="roster-button"], button[data-tid="calling-roster-button"], button[aria-label^="People"], button[aria-label*="participants" i]');
  if (!btn) return null;
  const read = (s) => { const m = /\\b(\\d{1,4})\\b/.exec(s || ''); return m ? Number(m[1]) : null; };
  const n = read(btn.textContent) ?? read(btn.getAttribute('aria-label')) ?? read(btn.getAttribute('title'));
  if (n !== null) return n;
  const stage = document.querySelector('[data-tid="calling-stage"], [data-tid="modern-stage-wrapper"], main');
  const text = stage ? stage.textContent || '' : '';
  if (/you('|’)re the only one here|no one else is here|waiting for others to join/i.test(text)) return 1;
  return 0;
})()`;

/**
 * Runs in the page: returns the newest few live captions as
 * [{id, speaker, text}], oldest first. Each caption bubble is tagged with a
 * stable id so the server can tell "same bubble, more words" from "new bubble".
 * Kept as a string so the bundler cannot rewrite it.
 */
export const CAPTIONS_JS = `(() => {
  const wrap = document.querySelector('[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-captions-renderer"], [data-tid="closed-caption-v2-window-wrapper"]');
  if (!wrap) return [];
  const texts = Array.from(wrap.querySelectorAll('[data-tid="closed-caption-text"]')).slice(-4);
  window.__abCapSeq = window.__abCapSeq || 0;
  return texts.map((el) => {
    if (!el.dataset.abId) el.dataset.abId = String(++window.__abCapSeq);
    let node = el, author = null;
    for (let i = 0; i < 6 && node && !author; i++) {
      node = node.parentElement;
      author = node && node.querySelector('[data-tid="author"]');
    }
    return { id: Number(el.dataset.abId), speaker: author ? author.textContent.trim() : '', text: el.textContent.trim() };
  });
})()`;
