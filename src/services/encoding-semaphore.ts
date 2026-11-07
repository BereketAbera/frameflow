import { abortError } from "./abort.js";

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  /** The slot is released when the operation settles, including when it rejects because the signal aborted it. */
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try { return await operation(); } finally { this.release(); }
  }

  /** An abort while waiting leaves the queue without taking a slot. */
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.maximum) { this.active += 1; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { this.waiting.splice(this.waiting.indexOf(grant), 1); reject(abortError(signal)); };
      const grant = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      this.waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A waiter inherits the slot directly, so a new caller cannot slip in between the release and the waiter resuming. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

const configuredMaximum = Number(process.env.MAX_CONCURRENT_ENCODES ?? 2);
export const encodingSemaphore = new Semaphore(
  Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0 ? configuredMaximum : 2,
);
