/**
 * Limits shared by every meeting running at the same time, so that several
 * meetings together cannot spend more ElevenLabs credit than one would.
 */

/** Characters the voice may speak per day, across all meetings. */
export class VoiceBudget {
  private day = '';
  private used = 0;

  constructor(
    private readonly dailyMax: number,
    /** Characters already spent today before this process started. */
    private readonly spentBefore: () => number = () => 0,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const today = this.now().toDateString();
    if (today === this.day) return;
    // First use, or a new day: start again from what the database says was spent today.
    this.day = today;
    this.used = this.spentBefore();
  }

  get max(): number {
    return this.dailyMax;
  }

  get spent(): number {
    this.roll();
    return this.used;
  }

  canSpend(chars: number): boolean {
    this.roll();
    return this.used + chars <= this.dailyMax;
  }

  spend(chars: number): void {
    this.roll();
    this.used += chars;
  }
}

/** Runs at most `size` tasks at once; the rest wait their turn in order. */
export class Slots {
  private busy = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.busy++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next in line, or free it.
      if (next) next();
      else this.busy--;
    }
  }
}

/** Midnight today, local time. */
export function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
