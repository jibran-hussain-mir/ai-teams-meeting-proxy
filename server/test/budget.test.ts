import { describe, expect, it } from 'vitest';
import { Slots, VoiceBudget } from '../src/audio/budget.js';

describe('VoiceBudget', () => {
  it('counts what was spent earlier today and stops at the daily limit', () => {
    const budget = new VoiceBudget(1000, () => 700);
    expect(budget.spent).toBe(700);
    expect(budget.canSpend(300)).toBe(true);
    budget.spend(250);
    expect(budget.canSpend(100)).toBe(false);
    expect(budget.canSpend(50)).toBe(true);
  });

  it('starts again on a new day', () => {
    let now = new Date(2026, 10, 15, 23, 0);
    let before = 0;
    const budget = new VoiceBudget(500, () => before, () => now);
    budget.spend(500);
    expect(budget.canSpend(1)).toBe(false);
    now = new Date(2026, 10, 16, 0, 5);
    before = 0;
    expect(budget.canSpend(400)).toBe(true);
    expect(budget.spent).toBe(0);
  });
});

describe('Slots', () => {
  it('never runs more than the allowed number at once, and runs everything', async () => {
    const slots = new Slots(2);
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        slots.run(async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 10));
          running--;
          done.push(n);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('frees the slot when a task fails', async () => {
    const slots = new Slots(1);
    await expect(slots.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(slots.run(async () => 'ok')).resolves.toBe('ok');
  });
});
