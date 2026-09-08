class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await operation(); } finally { this.release(); }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximum) { this.active += 1; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

const configuredMaximum = Number(process.env.MAX_CONCURRENT_ENCODES ?? 2);
export const encodingSemaphore = new Semaphore(
  Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0 ? configuredMaximum : 2,
);
