# Proxy

An AI assistant that attends Microsoft Teams meetings for you, several at the same time if they clash.

Paste a meeting link and your update. The assistant joins as "<Your name>'s AI Assistant", tells the room it is an AI speaking on your behalf, gives your update in your cloned voice when it is your turn, answers questions from the background you gave it, and messages you on Telegram when it does not know something. Your reply is spoken in the meeting. Afterwards you get a summary.

It runs on your own computer for one person. The only paid service is ElevenLabs (your voice). The thinking is done by Claude through your Claude Code subscription.

## Contents

- [Setup](#setup)
- [Using it](#using-it)
- [How it behaves in a meeting](#how-it-behaves-in-a-meeting)
- [Several meetings at once](#several-meetings-at-once)
- [Telegram](#telegram)
- [ElevenLabs credits](#elevenlabs-credits)
- [Architecture](#architecture)
- [Settings](#settings)
- [When something breaks](#when-something-breaks)
- [Checks](#checks)

## Setup

1. **Requirements:** Node 20+, and Claude Code installed and logged in on this machine (`claude` in a terminal should work).
2. **Install:**
   ```
   npm install
   npx playwright install chromium
   ```
3. **Configure:** copy `.env.example` to `.env` and fill in the first section:
   - `OWNER_NAME`: your name as colleagues say it.
   - `ELEVENLABS_API_KEY`: from elevenlabs.io. Voice cloning needs a paid plan.
   - `ELEVENLABS_VOICE_ID`: if you already cloned your voice on ElevenLabs, paste its Voice ID. Otherwise leave it empty and use the Voice page.
   - `TELEGRAM_BOT_TOKEN` (optional but recommended): create a bot with @BotFather in Telegram.
4. **Start:** `npm run dev`, then open http://127.0.0.1:5173.
5. **Telegram:** send `/start` to your bot. The first person to do so becomes the owner.
6. **Voice** (only if you have no Voice ID yet): open the Voice page, record the script for one to two minutes, and create your voice.

## Using it

- **New meeting:** paste the Teams link, write your update, add background facts (or upload .txt/.md/.pdf), and list anything it must not discuss. A browser window opens and joins the meeting; someone may need to admit the assistant from the lobby.
- **Rehearse first:** a text-only practice run with the same update and notes. You type what people in the meeting would say (and can simulate a quiet room) and see what the assistant would answer, which questions it would pass to you, and how many voice characters it would use. It does not join Teams and uses no ElevenLabs credits.
- **Join at:** set a time to schedule the meeting instead of joining now. The assistant joins on its own and sends a Telegram heads-up a few minutes before. This computer must be on with the app running. Scheduled meetings are listed under Upcoming and in History, where you can join early or cancel.
- **Meeting page:** transcript, what the assistant is doing, a mute button that cuts it off mid-sentence, a box to make it say something, and any questions waiting for you.
- **Live:** every meeting in progress on one screen, each with its last few lines, its open questions (answerable right there), and Mute / Leave.
- **History:** transcript, summary and ElevenLabs usage for every meeting.

## How it behaves in a meeting

**When it speaks**
- Stays silent unless asked for your update, addressed by name, or asked something your notes answer. If the room goes quiet for 20 seconds and the update has not been given, it offers it.
- Opens with a greeting for the time of day, followed by "this is <name>'s AI assistant, speaking on <name>'s behalf".
- Waits for a gap before speaking. If there is none it raises its hand, and after 25 seconds posts in the meeting chat instead.
- Stops immediately if someone talks over it.
- Thinks out loud: when asked something directly and the answer takes more than about a second, it says a short filler first ("Hmm, let me check.").

**What it will and will not say**
- Never guesses. Unknown questions, commitments (dates, money, decisions) and "do not discuss" topics are passed to you.
- Says which question it is answering: when you reply, it reads the question back first ("Sam just got back to me. Priya asked: What is the budget? Sam's answer: …").
- Asks people to repeat a question that is garbled or cut off, once, instead of guessing. Teams captions carry no confidence score, so Claude makes this call from the words themselves.
- Deflects off-topic requests (sums, "write me a program", "write a resignation letter") with a light line and an offer to help with your update. These are not passed to you.
- Says plainly that it is an AI whenever asked.

**When it leaves**
- When the meeting ends or it is removed.
- About 10 seconds after everyone else has left.
- When someone in the meeting tells it to leave; it says a short goodbye first.
- When nobody has spoken for 10 minutes.
- When you press Leave or send `/leave`.

In every case you get the summary, with any unanswered questions listed.

## Several meetings at once

The assistant can be in up to `MAX_MEETINGS` meetings at the same time (default 3). Use it when meetings clash (attend the important one yourself and send the assistant to the others) or when you cannot attend at all.

- Start or schedule meetings as usual; a new one does not have to wait for the previous one to end. Each has its own browser window, transcript, notes and voice allowance, and nothing said in one reaches another.
- Each running meeting gets a colour (🟦 🟩 🟧 🟪), used in the sidebar, on the Live page and in Telegram.
- A scheduled meeting that comes due while every place is taken waits up to 10 minutes for one to free up before giving up.
- **Do not disturb:** when you are in a meeting yourself, choose "Do not disturb me" on the form (or send `/dnd on` in Telegram for all meetings). The assistant then tells people you will follow up after the meeting, and unanswered questions arrive with the summary instead of as live messages.
- The assistant's browser windows produce no sound on your computer, so the meetings do not play over each other through your speakers.

**Machine resources.** Each meeting is a full Chromium running Teams. Every 30 seconds the server console prints what each meeting's browser uses, for example `[resources] 🟦 Stand-up: 640 MB, 0.60 cores (9 processes) · all meetings 0.63 GB · machine 7.9 of 16.0 GB free`, and the meeting page keeps the peak and average. Use these to decide `MAX_MEETINGS` for your computer (`RESOURCE_SAMPLE_SECONDS` changes how often; 0 turns it off).

One Teams account can only be active in one call at a time. If you join two meetings yourself with the same account to test, Teams puts your first call on hold; the assistant keeps working in both.

## Telegram

Everything stays in one chat, and every message starts with the meeting it is about, for example `🟦 Standup`.

- **Reply to a question** to answer it. The answer is spoken in the meeting the question came from.
- **Reply to any other message from a meeting** to say something there. The bot asks you to confirm first, so nothing is spoken by accident.
- **Buttons** under a question: "I'll follow up later" (the assistant tells the room and closes the question) and "Catch me up".
- **One status message per meeting** is updated in place (lobby, live, ended) with Mute, Catch me up and Leave buttons, so the chat stays quiet.
- A message that is not a reply is taken as the answer to the open question if there is exactly one; otherwise the bot asks what you meant.

| Command | What it does |
|---|---|
| `/meetings` | What is running and what is coming up |
| `/catchup` | What was said in the last few minutes |
| `/say <text>` | Say something in a meeting |
| `/mute`, `/unmute` | Silence the assistant, or let it speak again |
| `/leave` | Leave a meeting |
| `/dnd on` / `/dnd off` | Hold questions for the summary, or be asked live |

With one meeting running, commands act at once. With several, the bot asks which one, or all.

## ElevenLabs credits

The app is set up to spend as little as possible:

- **Listening is free by default.** The transcript comes from Teams' own live captions (`STT_MODE=captions`), so only the assistant's voice uses credits.
- **Per-meeting voice cap.** After `TTS_MAX_CHARS` characters (default 2500, roughly two and a half minutes of speech) replies are posted in the meeting chat instead, and you are told.
- **Daily voice cap across all meetings.** `TTS_DAILY_MAX_CHARS` (default 6000) is the overall ceiling when several meetings run.
- **Fillers are paid for once.** Each filler line is saved in `data/voice-cache` the first time it is spoken and replayed from disk after that.
- **Paid transcription is opt-in and capped.** With `STT_MODE=elevenlabs`, silence is never uploaded, and after `STT_MAX_MINUTES` of speech the assistant switches to captions.
- **Voice tests are limited** to `VOICE_TEST_MAX_CHARS` characters each. Creating the voice clone itself does not use character credits.
- **Rehearsals use none.**

`npm test` and `npm run spike:audio` never contact ElevenLabs.

## Architecture

Two parts in one repository: a Node server that does all the work, and a small React web app to control it. Everything runs locally and listens only on `127.0.0.1`.

```
 You
  │  browser                                    Telegram app
  ▼                                                  ▲ │
┌──────────────┐  REST + WebSocket   ┌───────────────┴─▼──────────────────────────────┐
│  Web app     │ ◄─────────────────► │  Server (Fastify)                               │
│  React/Vite  │                     │                                                 │
└──────────────┘                     │  MeetingManager ── up to MAX_MEETINGS at once   │
                                     │     │                                           │
                                     │     ├─ MeetingSession A ─┐                      │
                                     │     ├─ MeetingSession B  │ one per meeting      │
                                     │     └─ …                 ┘                      │
                                     │                                                 │
                                     │  Scheduler      TelegramHub      SQLite         │
                                     └─────────────────────────────────────────────────┘

 Inside one MeetingSession:

   Teams meeting                                                    ElevenLabs
        ▲ │ WebRTC audio                                                ▲ │
        │ ▼                                                        text │ ▼ voice (PCM)
 ┌───────────────────────────┐  captions (text + speaker)  ┌───────────────────────────┐
 │ TeamsBot                  │ ──────────────────────────► │ Session logic             │
 │ Chromium via Playwright   │  16 kHz audio (who talks)   │  speech detector (VAD)    │
 │ + injected audio bridge   │ ──────────────────────────► │  turn-taking, budgets     │
 │                           │ ◄────────────────────────── │  escalation, leaving      │
 └───────────────────────────┘  voice audio into fake mic  └────────────┬──────────────┘
                                                                transcript │ ▲ decision
                                                                           ▼ │ + words
                                                              ┌───────────────────────────┐
                                                              │ Brain: Claude             │
                                                              │ (Claude Agent SDK, your   │
                                                              │  Claude Code subscription)│
                                                              └───────────────────────────┘
```

### The pieces

| Piece | Where | What it does |
|---|---|---|
| Web app | `web/` | React 19 + Vite. Form to start, schedule or rehearse a meeting; live meeting page; overview of all running meetings; history; voice setup. Talks to the server over REST and gets live updates over a WebSocket. |
| API server | `server/src/index.ts` | Fastify. Routes for meetings, questions, voice and uploads; the dashboard WebSocket; wires everything together. |
| Settings | `server/src/config.ts` | The only place that reads `.env`. Every model name, limit and timing comes from here. |
| Meeting manager | `server/src/meeting/manager.ts` | Keeps the running sessions, enforces the limit, hands out a colour per meeting, refuses joining the same link twice. |
| Meeting session | `server/src/meeting/session.ts` | One meeting from join to summary: listens, decides when to think, waits for a gap, speaks, stops when talked over, escalates questions, relays your answers, applies voice budgets, decides when to leave. |
| Teams bot | `server/src/bot/teams.ts`, `selectors.ts` | Drives the Teams web client in Chromium through Playwright: joins as a guest, handles the lobby, turns on live captions, reads captions and the participant count, raises a hand, posts in chat, leaves. All page selectors are in `selectors.ts`. |
| Audio bridge | `server/src/bot/browser.ts`, `inject.page.js` | A script injected before Teams loads. It replaces the microphone with a stream the server can play audio into, and taps the incoming WebRTC audio and sends it to the server. |
| Hearing | `server/src/audio/vad.ts`, `captions.ts`, `stt.ts` | A loudness-based speech detector says *when* people talk. The words come from Teams captions (free) or, if switched on, ElevenLabs realtime transcription. |
| Voice | `server/src/audio/tts.ts`, `voice-cache.ts`, `budget.ts` | ElevenLabs streaming text-to-speech in your cloned voice; a disk cache for the filler lines; per-meeting and daily character limits; a queue for concurrent requests. |
| Brain | `server/src/brain/` | Claude through the Claude Agent SDK, one warm conversation per meeting. `prompts.ts` holds the instructions, `turn.ts` parses the reply and streams sentences to the voice as they are written, `summary.ts` writes the summary and catch-ups. |
| Telegram | `server/src/notify/hub.ts`, `telegram.ts` | `hub.ts` decides what every message, reply and button press means and which meeting it belongs to. `telegram.ts` is the thin grammY layer that sends and receives (long polling, so no public URL is needed). |
| Scheduler | `server/src/meeting/schedule.ts` | Decides, every few seconds, whether a scheduled meeting should wait, send a reminder, start, or be given up on. |
| Rehearsal | `server/src/meeting/rehearsal.ts` | Stand-ins for Teams and the voice so a session can run as text only. |
| Storage | `server/src/db.ts` | SQLite (better-sqlite3): meetings, transcript lines, questions, and which Telegram message belongs to which meeting. |

### What happens when someone asks a question

1. Their voice reaches the assistant's browser over WebRTC. The audio bridge passes it to the server, where the speech detector notes that someone is talking.
2. Teams shows a live caption with the speaker's name. The bot reads it; once the line stops changing it counts as said.
3. The session sends the new lines to Claude with the current state (update given or not, open questions). Lines that look addressed to the assistant go at once; ordinary chatter is batched.
4. Claude replies in a fixed format: an action (`silent`, `speak`, `escalate` or `leave`) and, if speaking, the words. The words are split into sentences as they stream in.
5. The session waits for a gap, then sends each sentence to ElevenLabs. The audio comes back in chunks and is played straight into the fake microphone, so Teams transmits it like any speech.
6. If the action was `escalate`, the question is saved, shown in the web app and sent to Telegram. Your reply is spoken at the next gap, with the question read back first.
7. If someone starts talking while the assistant speaks, playback is cut immediately and Claude is told it was interrupted.

### Technologies

| Used for | Technology |
|---|---|
| Language, runtime | TypeScript on Node 20, npm workspaces (`server`, `web`) |
| Server | Fastify, `@fastify/websocket`, `@fastify/multipart` |
| Joining Teams | Playwright driving Chromium |
| Audio in and out of the browser | WebRTC, WebAudio (injected script) |
| Voice | ElevenLabs text-to-speech and instant voice clone |
| Transcript | Teams live captions; optionally ElevenLabs realtime speech-to-text |
| Brain | Claude via `@anthropic-ai/claude-agent-sdk` |
| Messaging | Telegram via grammY |
| Storage | SQLite via better-sqlite3 |
| Web app | React 19, Vite, react-router |
| Tests | Vitest |

### Folders

```
.env.example        every setting, with its default
data/               database, voice cache, join-failure screenshots (created on first run)
server/src/
  index.ts          routes and wiring
  config.ts         all settings
  db.ts             SQLite
  meeting/          session, manager, scheduler, rehearsal
  bot/              Teams automation and the audio bridge
  audio/            speech detection, captions, transcription, voice, budgets
  brain/            Claude: prompts, turn handling, summaries
  notify/           Telegram
  spike/            stand-alone checks (audio loopback, brain scenarios)
server/test/        unit tests
web/src/            pages, API client, shared UI, styles
```

## Settings

Every setting lives in `.env`; nothing that changes behaviour is fixed in the code. `server/src/config.ts` is the only file that reads them, and `.env.example` documents each one. A setting you leave out falls back to the value shown in `.env.example`.

The groups are: who you are and keys, server ports, model names (Claude and ElevenLabs), credit limits, number of simultaneous meetings, fillers, turn-taking timings, when to leave, scheduling, and hearing thresholds. Restart the app after changing `.env`.

## When something breaks

- **"Cannot read Teams' live captions":** captions may be turned off for guests in that organisation, or the caption selectors in `server/src/bot/selectors.ts` need updating. `STT_MODE=elevenlabs` is the paid fallback.
- **It cannot join / cannot find a button:** Microsoft changes the Teams web page from time to time. Every selector is in `server/src/bot/selectors.ts`; a screenshot of the failure is saved in `data/`. Some organisations block guests from joining at all.
- **It does not leave when everyone else has gone:** it reads the number on Teams' People button. The server console prints `[teams] people in the meeting: N` whenever that changes; if no such line appears, the selector in `PARTICIPANTS_JS` (`selectors.ts`) needs updating. The 10-minute silence exit still applies.
- **It joins and follows the meeting but nobody hears it:** the audio inside its browser window has stalled. The assistant notices within a few seconds, tells you, and posts its replies in the meeting chat. The browser is started without any real sound device precisely to prevent this (it used to happen with Bluetooth earbuds connected); `npm run spike:audio` checks it on your machine.
- **"Claude is not responding":** your subscription's usage limit was reached or Claude Code is logged out. The assistant keeps transcribing and retries after two minutes.
- **One of my meetings went "on hold":** that is Teams holding your own first call when you joined a second with the same account. The assistant is unaffected.
- **Set `HEADLESS=1`** in `.env` to hide the browser windows once joining works reliably for you.

## Checks

```
npm test              # unit tests (no network)
npm run typecheck     # type checks for server and web
npm run spike:audio   # proves audio in/out of the browser works on this machine
npm run eval:brain -w server   # scripted meeting moments against Claude (uses your subscription)
```
