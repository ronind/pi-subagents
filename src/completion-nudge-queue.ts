import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { combineCompletionMessages } from "./completion-outbox.js";
import type { NotificationDetails } from "./types.js";

/** Hold completion messages outside Pi's non-retractable follow-up queue. */
export class CompletionNudgeQueue {
  private pending = new Map<string, {
    build: () => CustomMessageEntryDraft | undefined;
    due: number;
    scheduledWhileIdle: boolean;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private disposed = false;

  constructor(
    private readonly isIdle: () => boolean,
    private readonly send: (message: CustomMessageEntryDraft) => void,
  ) {}

  schedule(key: string, build: () => CustomMessageEntryDraft | undefined, delay = 200): void {
    if (this.disposed) return;
    this.cancel(key);
    const scheduledWhileIdle = this.isIdle();
    const entry = {
      build,
      due: Date.now() + delay,
      scheduledWhileIdle,
      timer: setTimeout(() => {
        if (!scheduledWhileIdle || !this.isIdle() || this.disposed || this.pending.get(key) !== entry) return;
        const messages = this.drainAtTurnEnd(true);
        try {
          if (messages.length === 1) this.send(messages[0]);
          else if (messages.length > 1) this.send({
            ...messages[0],
            ...combineCompletionMessages(messages.map(message => ({
              content: message.content as string,
              details: message.details as NotificationDetails,
            }))),
          });
        } catch { /* ignore stale completion side-effect errors */ }
      }, delay),
    };
    this.pending.set(key, entry);
  }

  cancel(key: string): void {
    const entry = this.pending.get(key);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  /**
   * Final actionable boundary, before CLI prompt() returns and disposes the
   * session. Snapshot only already-completed children: never join live agents.
   */
  async drainBeforeSettle(signal?: AbortSignal): Promise<CustomMessageEntryDraft[]> {
    if (this.disposed || signal?.aborted || this.pending.size === 0) return [];
    const snapshot = [...this.pending.entries()];
    const remaining = Math.max(0, ...snapshot.map(([, entry]) => entry.due - Date.now()));
    if (remaining > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    if (this.disposed || signal?.aborted) return [];
    const messages: CustomMessageEntryDraft[] = [];
    for (const [key, entry] of snapshot) {
      if (this.pending.get(key) !== entry) continue;
      // A child may have completed during the hold; it belongs to the next
      // boundary (or its own idle timer), not this snapshot.
      this.cancel(key);
      try {
        const message = entry.build();
        if (message) messages.push(message);
      } catch { /* one stale completion must not discard the remaining results */ }
    }
    return messages;
  }

  /** Tool-batch boundary: no idle hold is needed before the next model call. */
  drainAtTurnEnd(idleOnly = false): CustomMessageEntryDraft[] {
    if (this.disposed) return [];
    const messages: CustomMessageEntryDraft[] = [];
    for (const [key, entry] of [...this.pending]) {
      if (idleOnly && !entry.scheduledWhileIdle) continue;
      this.cancel(key);
      try {
        const message = entry.build();
        if (message) messages.push(message);
      } catch { /* isolate stale completions */ }
    }
    return messages;
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.pending.keys()) this.cancel(key);
  }
}
