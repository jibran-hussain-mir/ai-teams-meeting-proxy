import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';

/** Minimal chat interface so the brain can be tested without a real model. */
export interface Llm {
  /** Send one message; `onText` receives the reply as it streams. */
  ask(prompt: string, onText?: (delta: string) => void): Promise<string>;
  close(): void;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  onText?: (delta: string) => void;
  text: string;
}

/**
 * One long-lived Claude conversation, run through the Claude Agent SDK so it
 * uses the Claude Code login on this machine (your subscription) instead of
 * an API key. The underlying process takes a few seconds to start, so it is
 * created once per meeting and reused for every turn. All tools are disabled:
 * this is a plain text conversation.
 */
export class ClaudeSession implements Llm {
  private readonly inbox: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private dead: Error | null = null;
  private current: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly q: Query;

  constructor(systemPrompt: string, model = config.brainModel) {
    // Never bill an API key by accident: this app is meant to use the subscription.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    this.q = query({
      prompt: this.messages(),
      options: {
        model,
        systemPrompt,
        tools: [],
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        thinking: { type: 'disabled' },
        env,
      },
    });
    void this.pump();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        const cur = this.current;
        if (!cur) continue;
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            cur.text += ev.delta.text;
            cur.onText?.(ev.delta.text);
          }
        } else if (msg.type === 'result') {
          this.current = null;
          if (msg.subtype === 'success' && !msg.is_error) {
            cur.resolve(cur.text || msg.result);
          } else {
            const detail = msg.subtype === 'success' ? msg.result : msg.subtype;
            cur.reject(new Error(`Claude could not answer: ${detail}`));
          }
        }
      }
      this.dead = new Error('Claude session ended');
    } catch (err) {
      this.dead = err instanceof Error ? err : new Error(String(err));
    }
    this.current?.reject(this.dead);
    this.current = null;
  }

  ask(prompt: string, onText?: (delta: string) => void): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (this.dead) return reject(this.dead);
        if (this.closed) return reject(new Error('Claude session closed'));
        this.current = { resolve, reject, onText, text: '' };
        this.inbox.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        this.wake?.();
      });
    // One turn at a time: replies are matched to requests by order.
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    try {
      this.q.close();
    } catch {}
  }
}

/** One-off question on a fresh conversation (used for the meeting summary). */
export async function askOnce(systemPrompt: string, prompt: string, model = config.summaryModel): Promise<string> {
  const session = new ClaudeSession(systemPrompt, model);
  try {
    return await session.ask(prompt);
  } finally {
    session.close();
  }
}
