import { describe, expect, it } from 'vitest';
import { memoryOf, summarize, type ProcessSample } from '../src/bot/resources.js';

const MB = 1024 * 1024;
const p = (pid: number, cpuSeconds: number, mb: number): ProcessSample => ({ pid, type: 'renderer', cpuSeconds, memBytes: mb * MB });

describe('summarize', () => {
  it('adds up the memory of all the browser processes', () => {
    const u = summarize(null, { at: 0, processes: [p(1, 1, 200), p(2, 3, 300), p(3, 0, 50)] });
    expect(u).toEqual({ processes: 3, memMb: 550, cores: null });
  });

  it('turns CPU time between two samples into cores in use', () => {
    const prev = { at: 0, processes: [p(1, 10, 200), p(2, 20, 300)] };
    // Over 10 seconds: 4 s + 2 s of CPU, plus a new process that used 1 s.
    const cur = { at: 10_000, processes: [p(1, 14, 210), p(2, 22, 300), p(3, 1, 40)] };
    const u = summarize(prev, cur);
    expect(u.cores).toBeCloseTo(0.7);
    expect(u.memMb).toBe(550);
  });

  it('ignores processes that have gone and never reports negative CPU', () => {
    const prev = { at: 0, processes: [p(1, 10, 200), p(9, 50, 100)] };
    const cur = { at: 5000, processes: [p(1, 9, 200)] };
    expect(summarize(prev, cur).cores).toBe(0);
  });
});

describe('memoryOf', () => {
  it('reads the memory of a real process (this one)', async () => {
    const mem = await memoryOf([process.pid]);
    expect(mem.get(process.pid)).toBeGreaterThan(10 * MB);
  }, 20_000);

  it('skips processes that do not exist', async () => {
    const mem = await memoryOf([process.pid, 999_999_9]);
    expect(mem.has(999_999_9)).toBe(false);
  }, 20_000);
});
