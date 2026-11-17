import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Every setting that changes how the app behaves is read here, from `.env`,
 * and nowhere else. The second argument of each lookup is only the value used
 * when a line is missing from `.env`, so the app still starts with a minimal
 * file; `.env.example` lists every setting with the same values.
 */

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV_PATH = path.join(ROOT_DIR, '.env');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

dotenv.config({ path: ENV_PATH });
mkdirSync(DATA_DIR, { recursive: true });

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function text(name: string, fallback: string): string {
  return env(name) || fallback;
}

/** A number that may not be negative. */
function num(name: string, fallback: number): number {
  const value = env(name);
  const n = Number(value);
  return value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function list(name: string, fallback: string[], separator: string | RegExp = ','): string[] {
  const items = env(name)
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

/** On unless set to 0, false, no or off. */
function flag(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase();
  if (value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value);
}

export const config = {
  // ---- Who you are ----
  get ownerName() {
    return env('OWNER_NAME') || 'the owner';
  },
  get botDisplayName() {
    return `${this.ownerName}'s AI Assistant`;
  },

  // ---- Server ----
  get port() {
    return num('PORT', 8787) || 8787;
  },
  get headless() {
    return flag('HEADLESS', false);
  },
  get dbPath() {
    return text('AB_DB_PATH', path.join(DATA_DIR, 'agentic-brother.db'));
  },
  get uploadMaxMb() {
    return num('UPLOAD_MAX_MB', 25);
  },
  /** Hosts a meeting link may point to. */
  get teamsHosts() {
    return list('TEAMS_HOSTS', ['teams.microsoft.com', 'teams.live.com', 'teams.microsoft.us']);
  },

  // ---- ElevenLabs ----
  get elevenLabsApiKey() {
    return env('ELEVENLABS_API_KEY');
  },
  get elevenLabsVoiceId() {
    return env('ELEVENLABS_VOICE_ID');
  },
  get elevenLabsApiUrl() {
    return text('ELEVENLABS_API_URL', 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  },
  get elevenLabsSttUrl() {
    return text('ELEVENLABS_STT_URL', 'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  },
  get ttsModel() {
    return text('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5');
  },
  get sttModel() {
    return text('ELEVENLABS_STT_MODEL', 'scribe_v2_realtime');
  },

  // ---- Claude (through the Claude Code subscription) ----
  /** Decides what to do and writes what is said, live in the meeting. */
  get brainModel() {
    return text('BRAIN_MODEL', 'haiku');
  },
  /** Writes the notes after the meeting. */
  get summaryModel() {
    return text('SUMMARY_MODEL', 'sonnet');
  },
  /** Writes the mid-meeting catch-up. */
  get catchUpModel() {
    return text('CATCHUP_MODEL', this.brainModel);
  },
  get catchUpMinutes() {
    return num('CATCHUP_MINUTES', 10);
  },

  // ---- Telegram ----
  get telegramBotToken() {
    return env('TELEGRAM_BOT_TOKEN');
  },
  get telegramChatId() {
    return env('TELEGRAM_CHAT_ID');
  },

  // ---- ElevenLabs credit limits ----
  /** 'captions' (free, reads Teams' live captions) or 'elevenlabs' (paid). */
  get sttMode(): 'captions' | 'elevenlabs' {
    return env('STT_MODE').toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'captions';
  },
  /** Paid transcription stops after this many minutes of audio per meeting. */
  get sttMaxMinutes() {
    return num('STT_MAX_MINUTES', 15);
  },
  /** Characters the voice may speak per meeting; after that replies go to chat. */
  get ttsMaxChars() {
    return num('TTS_MAX_CHARS', 2500);
  },
  /** Characters the voice may speak per day across all meetings; after that replies go to chat. */
  get ttsDailyMaxChars() {
    return num('TTS_DAILY_MAX_CHARS', 6000);
  },
  /** ElevenLabs requests allowed at the same time. */
  get ttsConcurrency() {
    return Math.max(1, Math.floor(num('TTS_CONCURRENCY', 2)));
  },
  /** Longest sentence the Voice page will speak as a test. */
  get voiceTestMaxChars() {
    return Math.max(1, Math.floor(num('VOICE_TEST_MAX_CHARS', 120)));
  },

  // ---- Several meetings ----
  /** Real meetings the assistant may attend at the same time. Each one is a browser window. */
  get maxMeetings() {
    return Math.max(1, Math.floor(num('MAX_MEETINGS', 3)));
  },

  // ---- Thinking out loud ----
  /** Say a short filler while a direct question is being answered. */
  get fillers() {
    return flag('FILLERS', true);
  },
  /** The filler lines, separated by | in .env. Each is paid for once and then replayed from disk. */
  get fillerLines() {
    return list(
      'FILLER_LINES',
      ['Hmm, let me check.', 'Um, one second.', 'Okay, let me see.', 'Hmm, okay.', 'Right, so.'],
      '|',
    );
  },

  // ---- Hearing ----
  /** Loudness (0 to 1) above which sound counts as someone talking. */
  get vadThreshold() {
    return num('VAD_THRESHOLD', 0.02);
  },
  /** Continuous sound needed before it counts as speech, to ignore clicks and coughs. */
  get vadMinSpeechMs() {
    return num('VAD_MIN_SPEECH_MS', 400);
  },
  /** A caption counts as finished once it has not changed for this long. */
  get captionStableMs() {
    return num('CAPTION_STABLE_MS', 1500);
  },
  /** The same, when the caption already ends a sentence. */
  get captionSentenceStableMs() {
    return num('CAPTION_SENTENCE_STABLE_MS', 700);
  },

  // ---- Joining and scheduling ----
  get lobbyTimeoutMs() {
    return num('LOBBY_TIMEOUT_MINUTES', 10) * 60_000;
  },
  /** Tell the owner this long before a scheduled join. */
  get scheduleRemindMs() {
    return num('SCHEDULE_REMIND_MINUTES', 5) * 60_000;
  },
  /** Still join if the start time passed no longer ago than this. */
  get scheduleLateMs() {
    return num('SCHEDULE_LATE_MINUTES', 10) * 60_000;
  },

  // ---- Turn-taking in the meeting ----
  get timing() {
    return {
      /** Quiet needed before the assistant starts talking. */
      floorSilenceMs: num('FLOOR_SILENCE_MS', 600),
      /** Raise a hand after waiting this long for a gap. */
      raiseHandAfterMs: num('RAISE_HAND_AFTER_SECONDS', 6) * 1000,
      /** Give up waiting and post in chat instead. */
      giveUpFloorAfterMs: num('CHAT_FALLBACK_AFTER_SECONDS', 25) * 1000,
      /** Quiet room this long with the update undelivered: offer it. */
      lullMs: num('LULL_SECONDS', 20) * 1000,
      lullRetryMs: num('LULL_RETRY_SECONDS', 90) * 1000,
      /** Lines that do not look addressed to the assistant are batched for this long. */
      batchMs: num('BATCH_SECONDS', 6) * 1000,
      /** Leave when nobody has spoken for this long. */
      idleExitMs: num('IDLE_EXIT_MINUTES', 10) * 60_000,
      /** Leave this long after everyone else has left. */
      aloneExitMs: num('ALONE_EXIT_SECONDS', 10) * 1000,
      /** Wait before retrying a failed brain. */
      brainRetryMs: num('BRAIN_RETRY_SECONDS', 120) * 1000,
      /** Asked something directly and still thinking after this long: say a filler. */
      fillerAfterMs: num('FILLER_AFTER_MS', 900),
      /** Speech that has not moved for this long is not reaching the meeting: switch to chat. */
      audioStallMs: num('AUDIO_STALL_SECONDS', 3) * 1000,
      /** Measure the meeting browser's memory and CPU this often; 0 turns it off. */
      resourceSampleMs: num('RESOURCE_SAMPLE_SECONDS', 30) * 1000,
    };
  },
};

/** What is still missing before a meeting can be joined. */
export function missingSetup(): string[] {
  const missing: string[] = [];
  if (!env('OWNER_NAME')) missing.push('OWNER_NAME');
  if (!config.elevenLabsApiKey) missing.push('ELEVENLABS_API_KEY');
  if (!config.elevenLabsVoiceId) missing.push('ELEVENLABS_VOICE_ID (create your voice on the Voice Setup page)');
  return missing;
}

/** Persist a setting to .env and the running process. */
export function saveEnvValue(name: string, value: string): void {
  process.env[name] = value;
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (idx >= 0) lines[idx] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_PATH, lines.join('\n'));
}
