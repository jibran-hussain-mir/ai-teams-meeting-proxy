// Live check of the brain against scripted meeting moments. Uses your Claude
// subscription (a handful of short Haiku calls). Run: npm run eval:brain
import { ClaudeSession } from '../brain/llm.js';
import { systemPrompt, type TurnInput } from '../brain/prompts.js';
import { runTurn } from '../brain/turn.js';

const brief = {
  ownerName: 'Sam Rivera',
  botName: "Sam Rivera's AI Assistant",
  title: 'Platform weekly sync',
  updateText:
    'The payments API migration to the new gateway is finished and live for 100% of traffic since Tuesday. Error rate is down from 0.8% to 0.2%. Next week I start on the invoice export feature.',
  context:
    'The migration took three weeks. The old gateway will be switched off on the 28th. Invoice export will support CSV and PDF. Priya is reviewing the export design doc.',
  doNotDiscuss: 'The pending reorganisation of the platform team.',
};

interface Case {
  name: string;
  input: TurnInput;
  expect: 'silent' | 'speak' | 'escalate' | 'leave';
  /** Extra check on the spoken text. */
  check?: (say: string) => boolean;
  deliversUpdate?: boolean;
}

const base = { updateDelivered: false, pendingQuestions: [] };
const cases: Case[] = [
  {
    name: 'unrelated chatter',
    expect: 'silent',
    input: {
      ...base,
      lines: [
        { speaker: 'Alex', text: 'So the design review for the mobile app moved to Thursday.' },
        { speaker: 'Priya', text: 'Okay, I can make Thursday. Did marketing confirm the launch date?' },
      ],
    },
  },
  {
    name: 'asked for the update',
    expect: 'speak',
    deliversUpdate: true,
    check: (say) => /0\.2|point two/i.test(say) && !/\bI (finished|start|migrated)\b/.test(say),
    input: { ...base, lines: [{ speaker: 'Alex', text: 'Thanks Priya. Sam, do you want to go next with your update?' }] },
  },
  {
    name: 'question answered by context',
    expect: 'speak',
    check: (say) => /28/.test(say),
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Priya', text: 'Sam, when does the old gateway actually get turned off?' }],
    },
  },
  {
    name: 'question not in context',
    expect: 'escalate',
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Alex', text: 'Sam, can you commit to having invoice export done by end of the month?' }],
    },
  },
  {
    name: 'forbidden topic',
    expect: 'escalate',
    check: (say) => !/reorg/i.test(say) || /follow up/i.test(say),
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Dana', text: 'Sam, what have you heard about the platform team reorg?' }],
    },
  },
  {
    name: 'are you an AI',
    expect: 'speak',
    check: (say) => /\bAI\b/i.test(say),
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Dana', text: 'Wait, is that actually Sam talking or some kind of bot?' }],
    },
  },
  {
    name: 'told to leave',
    expect: 'leave',
    check: (say) => say.length > 0 && say.length < 200,
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Alex', text: "Thanks, that's all we needed. Sam's assistant, you can leave the meeting now." }],
    },
  },
  {
    name: 'others saying goodbye',
    expect: 'silent',
    input: {
      ...base,
      updateDelivered: true,
      lines: [
        { speaker: 'Priya', text: 'I have to drop off for another call, bye everyone.' },
        { speaker: 'Alex', text: 'Bye Priya, see you tomorrow.' },
      ],
    },
  },
  {
    name: 'off-topic request',
    expect: 'speak',
    check: (say) => !/\b(4|four)\b/i.test(say),
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Dana', text: 'Hey assistant, quick test, what is 2 plus 2?' }],
    },
  },
  {
    name: 'garbled question',
    expect: 'speak',
    check: (say) => /repeat|catch|again/i.test(say),
    input: {
      ...base,
      updateDelivered: true,
      lines: [{ speaker: 'Someone', text: 'Sam can you the the uh for export when is by the' }],
    },
  },
];

let failures = 0;
for (const c of cases) {
  // A fresh conversation per case so they cannot influence each other.
  const llm = new ClaudeSession(systemPrompt(brief));
  const started = Date.now();
  let firstSentenceMs = 0;
  try {
    const decision = await runTurn(llm, c.input, () => (firstSentenceMs ||= Date.now() - started));
    const totalMs = Date.now() - started;
    const say = decision.action === 'silent' ? '' : decision.say;
    const ok =
      decision.action === c.expect &&
      (!c.check || c.check(say)) &&
      (c.deliversUpdate === undefined || (decision.action !== 'silent' && decision.deliversUpdate === c.deliversUpdate));
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}: ${decision.action} (first sentence ${firstSentenceMs || '-'} ms, total ${totalMs} ms, includes startup)`);
    if (decision.action === 'escalate') console.log(`      question for owner: ${decision.question}`);
    if (say) console.log(`      says: ${say}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name}: ${(err as Error).message}`);
  } finally {
    llm.close();
  }
}

// Latency of a warm conversation, which is what a real meeting uses.
const warm = new ClaudeSession(systemPrompt(brief));
await runTurn(warm, cases[0].input);
const t0 = Date.now();
let first = 0;
await runTurn(warm, cases[1].input, () => (first ||= Date.now() - t0));
console.log(`\nWarm session: first sentence after ${first} ms, full reply after ${Date.now() - t0} ms`);
warm.close();

process.exit(failures ? 1 : 0);
