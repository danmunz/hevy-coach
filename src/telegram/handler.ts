import { TurnContext, TurnDeadlineError, TurnExpiredError, TurnQueue } from '../claude/turn-queue.js';
import { DeliveryError, safeErrorFields, sanitizeHtml } from './client.js';

export interface MessageTurn {
  queue: TurnQueue;
  receivedAt: number;
  coach: (turn: TurnContext) => Promise<string>;
  deliver: (text: string, deadlineAt: number) => Promise<void>;
  logFailure: (fields: ReturnType<typeof safeErrorFields>) => void;
}

export function deliveryFailureNotice(error: DeliveryError): string {
  const status = error.deliveredChunks > 0
    ? `Only ${error.deliveredChunks} of ${error.totalChunks} reply parts were confirmed.`
    : 'I could not confirm delivery of the reply.';
  return `${status} Coaching finished before delivery failed. Saved changes may already be complete. Check the app before repeating a change request.`;
}

/** Keep coaching, delivery, and any failure notice in the same ordered queue slot. */
export async function handleMessageTurn(options: MessageTurn): Promise<void> {
  const report = async (error: unknown): Promise<void> => {
    options.logFailure(safeErrorFields(error));
    const notice = error instanceof DeliveryError ? deliveryFailureNotice(error)
      : error instanceof TurnExpiredError ? error.message
      : error instanceof TurnDeadlineError ? 'Coaching reached its time limit. Some changes may already be saved. Check the app before repeating a change request.'
      : 'Coaching did not finish. Some changes may already be saved. Check the app before repeating a change request.';
    try { await options.deliver(notice, Date.now() + 5_000); }
    catch (noticeError) { options.logFailure(safeErrorFields(noticeError)); }
  };
  try {
    await options.queue.run(async turn => {
      try {
        const response = sanitizeHtml(await options.coach(turn));
        await options.deliver(response.trim() ? response : 'Coaching finished without a reply. Check the app before repeating a change request.', turn.deadlineAt);
      } catch (error) { await report(error); }
    }, options.receivedAt);
  } catch (error) {
    // Expired turns never enter the queue callback. Rejoin the queue for their
    // bounded notice so it cannot overtake a later reply.
    await options.queue.run(() => report(error));
  }
}
