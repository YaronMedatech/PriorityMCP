// A sliding-window ceiling on how many requests one session may send to
// Priority.
//
// Every per-call limit in this server bounds a SINGLE call: `aggregate` stops at
// maxRows, `describe_screen` stops at its metadata budget, `query` stops at 500
// rows. Nothing bounded the calls themselves, and the expensive tools here are
// expensive by paging: one `aggregate` over 50,000 rows is hundreds of sequential
// requests. A model in a retry loop can therefore hammer a production ERP without
// exceeding any documented limit, which is the gap this closes.
//
// Deliberately per-session, not global. In stdio each client is its own process,
// and over HTTP `openSession` builds a fresh server -- and so a fresh
// PriorityODataClient -- per session, so an instance-level window IS a per-session
// window with no session id to thread through. What it does NOT do is bound the
// total load several sessions put on Priority together; that would need shared
// state and is a different feature.

const DEFAULT_WINDOW_MS = 60_000;

/**
 * Granted, or refused with how long a slot would have taken.
 *
 * A verdict rather than a thrown error, so the Priority-facing message stays in
 * odata.ts with the rest of them -- and so this module needs nothing from
 * odata.ts, which would otherwise be a circular import.
 */
export type BudgetVerdict = { granted: true } | { granted: false; wouldWaitMs: number };

export class RequestBudget {
  /** Timestamps inside the current window, oldest first. */
  private readonly sent: number[] = [];

  /**
   * @param maxPerWindow Requests allowed per window. 0 or less disables the budget.
   * @param windowMs Length of the window. Parameterised for the tests, which
   *   cannot spend a real minute proving that the window slides.
   */
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  get limit(): number {
    return this.maxPerWindow;
  }

  /**
   * Take a slot, waiting for one if necessary.
   *
   * Refuses instead of sleeping past `deadline`, which is the same rule
   * `backoff()` follows in odata.ts and matters for the same reason: a limiter
   * that sleeps past the caller's deadline converts "you are over budget" into a
   * generic timeout, and a timeout reads as a problem with the Priority server.
   */
  async acquire(deadline: number): Promise<BudgetVerdict> {
    if (this.maxPerWindow <= 0) return { granted: true };

    for (;;) {
      const now = Date.now();
      this.forgetBefore(now - this.windowMs);

      // Check and claim in the same tick. There is no await between them, so
      // concurrent callers -- describe_screen's parallel metadata fetches, for
      // one -- cannot both see the same free slot.
      if (this.sent.length < this.maxPerWindow) {
        this.sent.push(now);
        return { granted: true };
      }

      // forgetBefore just dropped everything older than the window, so the oldest
      // survivor expires in the future and this wait is always positive.
      const wait = this.sent[0]! + this.windowMs - now;
      if (now + wait >= deadline) return { granted: false, wouldWaitMs: wait };

      await sleep(wait);
      // Round again rather than assuming the slot is ours: several waiters can
      // wake to the same freed slot, and only one of them may have it.
    }
  }

  private forgetBefore(cutoff: number): void {
    let drop = 0;
    while (drop < this.sent.length && this.sent[drop]! <= cutoff) drop++;
    if (drop > 0) this.sent.splice(0, drop);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
