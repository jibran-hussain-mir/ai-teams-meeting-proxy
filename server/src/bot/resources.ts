import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { CDPSession } from 'playwright';

const run = promisify(execFile);

/** One process of a meeting's browser at one moment. */
export interface ProcessSample {
  pid: number;
  /** browser, renderer, GPU, network service… */
  type: string;
  /** Total CPU time used since the process started. */
  cpuSeconds: number;
  /** Memory this process accounts for; 0 if it could not be read. */
  memBytes: number;
}

/** What one meeting's browser is using right now. */
export interface BrowserUsage {
  processes: number;
  memMb: number;
  /** CPU cores in use since the previous sample; null on the first sample. */
  cores: number | null;
}

/**
 * Sum the processes of one browser. CPU is the CPU time used between the two
 * samples divided by the time between them: 1.0 means one core fully busy.
 * Processes that started after the previous sample count with all their time.
 */
export function summarize(
  prev: { at: number; processes: ProcessSample[] } | null,
  cur: { at: number; processes: ProcessSample[] },
): BrowserUsage {
  const memMb = cur.processes.reduce((n, p) => n + p.memBytes, 0) / (1024 * 1024);
  let cores: number | null = null;
  const seconds = prev ? (cur.at - prev.at) / 1000 : 0;
  if (prev && seconds > 0) {
    const before = new Map(prev.processes.map((p) => [p.pid, p.cpuSeconds]));
    let used = 0;
    for (const p of cur.processes) used += Math.max(0, p.cpuSeconds - (before.get(p.pid) ?? 0));
    cores = used / seconds;
  }
  return { processes: cur.processes.length, memMb, cores };
}

/**
 * Memory per process, in bytes, from the operating system.
 * Windows: private memory (what this process alone costs; the working set
 *   would count pages shared between Chromium's processes several times).
 * Linux: proportional set size (shared pages split between their users), else RSS.
 * macOS: resident size.
 */
export async function memoryOf(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length) return out;

  if (process.platform === 'win32') {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // A process that has just exited is skipped; that is not a failure.
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64)" }; exit 0`,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, bytes] = line.trim().split(/\s+/).map(Number);
      if (pid && Number.isFinite(bytes)) out.set(pid, bytes);
    }
    return out;
  }

  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
          const pss = /^Pss:\s+(\d+) kB/m.exec(rollup);
          if (pss) return void out.set(pid, Number(pss[1]) * 1024);
        } catch {}
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
          if (rss) out.set(pid, Number(rss[1]) * 1024);
        } catch {}
      }),
    );
    return out;
  }

  const { stdout } = await run('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { timeout: 15_000 });
  for (const line of stdout.split('\n')) {
    const [pid, kb] = line.trim().split(/\s+/).map(Number);
    if (pid && Number.isFinite(kb)) out.set(pid, kb * 1024);
  }
  return out;
}

/** Measures one browser. Each call to `sample()` reports usage since the previous call. */
export class BrowserMeter {
  private cdp: CDPSession | null = null;
  private prev: { at: number; processes: ProcessSample[] } | null = null;

  constructor(private readonly openSession: () => Promise<CDPSession>) {}

  async sample(): Promise<BrowserUsage> {
    this.cdp ??= await this.openSession();
    // The browser lists its own processes, so no guessing which ones belong to this meeting.
    const info = (await this.cdp.send('SystemInfo.getProcessInfo' as never)) as unknown as {
      processInfo: { type: string; id: number; cpuTime: number }[];
    };
    const memory = await memoryOf(info.processInfo.map((p) => p.id));
    const cur = {
      at: Date.now(),
      processes: info.processInfo.map((p) => ({
        pid: p.id,
        type: p.type,
        cpuSeconds: p.cpuTime,
        memBytes: memory.get(p.id) ?? 0,
      })),
    };
    const usage = summarize(this.prev, cur);
    this.prev = cur;
    return usage;
  }
}
