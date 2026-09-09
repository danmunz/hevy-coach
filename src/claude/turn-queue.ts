export class TurnExpiredError extends Error {
  constructor() {
    super('This message waited too long for an earlier request to finish. Please send it again.');
    this.name = 'TurnExpiredError';
  }
}

export class TurnDeadlineError extends Error {
  constructor() {
    super('This request took too long to finish. Please send it again.');
    this.name = 'TurnDeadlineError';
  }
}

/**
 * A model request was stopped before the turn deadline so Telegram still has
 * time to deliver a useful, unambiguous reply. This is distinct from a hard
 * turn deadline: earlier tool calls may have completed, but this call did not.
 */
export class ModelResponseTimeoutError extends Error {
  constructor() {
    super('The coaching model did not finish its reply in the allotted time. Please send the request again.');
    this.name = 'ModelResponseTimeoutError';
  }
}

export interface TurnContext {
  receivedAt: number;
  startedAt: number;
  deadlineAt: number;
  queueWaitMs: number;
}

/**
 * One owner can safely use one ordered, in-memory turn queue. It prevents two
 * incoming messages from racing chat history or a routine update. A rejected
 * turn is deliberately swallowed by the tail so later work still runs.
 */
export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly maxWaitMs = 75_000, private readonly now = () => Date.now()) {}

  run<T>(work: (context: TurnContext) => Promise<T>, receivedAt = this.now()): Promise<T> {
    const deadlineAt = receivedAt + this.maxWaitMs;
    const previous = this.tail;
    const result = previous.then(async () => {
      const startedAt = this.now();
      if (startedAt >= deadlineAt) throw new TurnExpiredError();
      return work({ receivedAt, startedAt, deadlineAt, queueWaitMs: startedAt - receivedAt });
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
