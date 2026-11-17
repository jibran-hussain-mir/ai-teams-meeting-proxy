import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import type { TranscriberEvents } from './captions.js';
import { Vad } from './vad.js';

const SAMPLE_RATE = 16000;
/** Server-side fatal errors: reconnecting would just fail again. */
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms']);

/** Keep sending this long after speech stops, so the service can close the turn. */
const HANGOVER_MS = 2000;
/** Frames kept from just before speech starts, so first words are not clipped. */
const PREROLL_FRAMES = 4;

/**
 * ElevenLabs realtime speech-to-text (Scribe). Feed 16 kHz PCM16 with
 * `send()`; turns are committed by the service's own voice-activity detector.
 *
 * To save credits, silence is never uploaded (only audio around speech), and
 * a `limit` event fires once `maxSeconds` of audio has been sent.
 */
export class RealtimeStt extends EventEmitter<TranscriberEvents> {
  readonly usesCaptions = false;
  private readonly gate = new Vad(SAMPLE_RATE, 0.012, 60);
  private preroll: Buffer[] = [];
  private lastSpeechAt = 0;
  private limitHit = false;
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private pending: Buffer[] = [];
  private retries = 0;
  /** Seconds of audio sent, for the usage figure on the History page. */
  secondsSent = 0;

  constructor(
    private readonly keyterms: string[] = [],
    private readonly maxSeconds = Infinity,
  ) {
    super();
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    const params = new URLSearchParams({
      model_id: config.sttModel,
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: '0.7',
    });
    for (const term of this.keyterms.slice(0, 20)) params.append('keyterms', term);

    const ws = new WebSocket(`${config.elevenLabsSttUrl}?${params}`, {
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    this.ws = ws;

    ws.on('message', (raw) => {
      let msg: { message_type?: string; text?: string; error?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.message_type) {
        case 'session_started':
          this.ready = true;
          this.retries = 0;
          for (const frame of this.pending) this.sendFrame(frame);
          this.pending = [];
          break;
        case 'partial_transcript':
          if (msg.text?.trim()) this.emit('partial', msg.text.trim());
          break;
        case 'committed_transcript':
          if (msg.text?.trim()) this.emit('final', msg.text.trim());
          break;
        case 'insufficient_audio_activity':
        case 'commit_throttled':
        case 'warning':
          break; // normal during long silences
        default:
          if (msg.message_type && FATAL.has(msg.message_type)) {
            this.closed = true;
            this.emit('fatal', `Speech-to-text stopped: ${msg.message_type} ${msg.error ?? ''}`.trim());
            ws.close();
          } else if (msg.error) {
            console.warn(`[stt] ${msg.message_type}: ${msg.error}`);
          }
      }
    });

    ws.on('error', (err) => console.warn('[stt] socket error:', err.message));
    ws.on('close', () => {
      this.ready = false;
      if (this.closed) return;
      // Sessions have a time limit and networks drop: reconnect and carry on.
      this.retries++;
      if (this.retries > 8) {
        this.closed = true;
        this.emit('fatal', 'Speech-to-text could not reconnect');
        return;
      }
      setTimeout(() => !this.closed && this.connect(), Math.min(5000, 300 * this.retries));
    });
  }

  send(pcm: Buffer, now = Date.now()): void {
    if (this.closed || this.limitHit) return;
    if (this.gate.push(pcm, now)) this.lastSpeechAt = now;
    if (now - this.lastSpeechAt >= HANGOVER_MS) {
      // Silence: hold on to the last few frames but upload nothing.
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      return;
    }
    const frames = [...this.preroll, pcm];
    this.preroll = [];
    for (const frame of frames) {
      if (this.ready) {
        this.sendFrame(frame);
      } else {
        // Keep at most ~5 s while (re)connecting.
        this.pending.push(frame);
        if (this.pending.length > 60) this.pending.shift();
      }
    }
    if (this.secondsSent >= this.maxSeconds) {
      this.limitHit = true;
      this.emit('limit');
    }
  }

  private sendFrame(pcm: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.secondsSent += pcm.length / 2 / SAMPLE_RATE;
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcm.toString('base64'),
        commit: false,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
