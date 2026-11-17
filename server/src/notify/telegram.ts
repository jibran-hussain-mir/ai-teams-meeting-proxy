import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config, saveEnvValue } from '../config.js';
import { HELP, type Outgoing, type TelegramHub, type Transport } from './hub.js';

/** Telegram refuses messages longer than 4096 characters. */
const MAX_TEXT = 4000;

function keyboard(msg: Outgoing): InlineKeyboard | undefined {
  if (!msg.buttons?.length) return undefined;
  return InlineKeyboard.from(msg.buttons.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))));
}

/**
 * The Telegram end of the hub: long polling (so no public URL is needed),
 * sending, editing, and passing commands, replies and button presses on.
 * Only the configured chat is ever listened to or written to.
 */
export class TelegramTransport implements Transport {
  private bot: Bot | null = null;

  get enabled(): boolean {
    return this.bot !== null && config.telegramChatId !== '';
  }

  start(hub: TelegramHub): void {
    if (!config.telegramBotToken) {
      console.log('[telegram] TELEGRAM_BOT_TOKEN not set: Telegram alerts are off');
      return;
    }
    const bot = new Bot(config.telegramBotToken);
    this.bot = bot;

    bot.command('start', async (ctx) => {
      const chatId = String(ctx.chat.id);
      if (!config.telegramChatId) {
        // First person to say hello becomes the owner.
        saveEnvValue('TELEGRAM_CHAT_ID', chatId);
        await ctx.reply(`Connected. Meeting alerts will arrive here.\n\n${HELP}`);
      } else if (chatId === config.telegramChatId) {
        await ctx.reply(`Already connected.\n\n${HELP}`);
      } else {
        await ctx.reply('This bot is already linked to someone else.');
      }
    });

    // Everything below is owner-only.
    bot.use(async (ctx, next) => {
      if (String(ctx.chat?.id ?? '') === config.telegramChatId) await next();
    });

    const reply = (ctx: Context, msg: Outgoing) =>
      ctx.reply(msg.text.slice(0, MAX_TEXT), { reply_markup: keyboard(msg) });

    for (const name of ['help', 'meetings', 'status', 'catchup', 'say', 'mute', 'unmute', 'leave', 'dnd']) {
      bot.command(name, async (ctx) => reply(ctx, await hub.command(name, ctx.match)));
    }

    bot.on('message:text', async (ctx) => {
      await reply(ctx, await hub.text(ctx.message.text.trim(), ctx.message.reply_to_message?.message_id));
    });

    bot.on('callback_query:data', async (ctx) => {
      // Stop the button's loading spinner straight away; the work may take a moment.
      await ctx.answerCallbackQuery().catch(() => {});
      const result = await hub.button(ctx.callbackQuery.data);
      if (result.replace) {
        await ctx
          .editMessageText(result.text.slice(0, MAX_TEXT), { reply_markup: keyboard(result) })
          .catch(() => reply(ctx, result));
      } else {
        await reply(ctx, result);
      }
    });

    bot.catch((err) => console.warn('[telegram]', err.message));
    void bot.api
      .setMyCommands([
        { command: 'meetings', description: 'What is running and coming up' },
        { command: 'catchup', description: 'What was said in the last few minutes' },
        { command: 'say', description: 'Say something in a meeting' },
        { command: 'mute', description: 'Silence the assistant' },
        { command: 'unmute', description: 'Let it speak again' },
        { command: 'leave', description: 'Leave a meeting' },
        { command: 'dnd', description: 'on / off: hold questions for the summary' },
        { command: 'help', description: 'How this works' },
      ])
      .catch(() => {});
    void bot.start({ drop_pending_updates: true }).catch((err) => {
      console.warn('[telegram] could not start:', err.message);
      this.bot = null;
    });
  }

  async send(msg: Outgoing): Promise<number[]> {
    if (!this.enabled) return [];
    const ids: number[] = [];
    try {
      for (let i = 0; i < msg.text.length; i += MAX_TEXT) {
        const last = i + MAX_TEXT >= msg.text.length;
        const sent = await this.bot!.api.sendMessage(config.telegramChatId, msg.text.slice(i, i + MAX_TEXT), {
          // Buttons go under the final part of a long message.
          reply_markup: last ? keyboard(msg) : undefined,
        });
        ids.push(sent.message_id);
      }
    } catch (err) {
      console.warn('[telegram] send failed:', (err as Error).message);
    }
    return ids;
  }

  async edit(messageId: number, msg: Outgoing): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.bot!.api.editMessageText(config.telegramChatId, messageId, msg.text.slice(0, MAX_TEXT), {
        reply_markup: keyboard(msg),
      });
    } catch (err) {
      // Telegram rejects an edit that changes nothing; that is not a problem.
      const message = (err as Error).message;
      if (!message.includes('not modified')) console.warn('[telegram] edit failed:', message);
    }
  }

  async stop(): Promise<void> {
    await this.bot?.stop().catch(() => {});
  }
}
