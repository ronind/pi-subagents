import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionNudgeQueue } from "../src/completion-nudge-queue.js";

const message = (content: string): CustomMessageEntryDraft => ({
  type: "custom_message", customType: "subagent-notification", content, display: true,
});

describe("completion nudges remain retractable until delivery", () => {
  let idle: boolean;
  let send: ReturnType<typeof vi.fn>;
  let queue: CompletionNudgeQueue;
  beforeEach(() => {
    vi.useFakeTimers();
    idle = false;
    send = vi.fn();
    queue = new CompletionNudgeQueue(() => idle, send);
  });
  afterEach(() => { queue.dispose(); vi.useRealTimers(); });

  it("holds past 200ms while busy, then re-checks consumption at the actionable boundary", async () => {
    let consumed = false;
    queue.schedule("agent", () => consumed ? undefined : message("agent"));
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    consumed = true;
    expect(await queue.drainBeforeSettle()).toEqual([]);
  });

  it("returns unread custom-message drafts to the host before CLI exit, only once", async () => {
    queue.schedule("agent", () => message("agent"));
    vi.advanceTimersByTime(1000);
    expect(await queue.drainBeforeSettle()).toEqual([message("agent")]);
    expect(await queue.drainBeforeSettle()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits only the remaining idle hold at the final boundary", async () => {
    queue.schedule("agent", () => message("agent"));
    const pending = queue.drainBeforeSettle();
    await vi.advanceTimersByTimeAsync(199);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([message("agent")]);
  });

  it("allows cancellation while the boundary is waiting", async () => {
    queue.schedule("agent", () => message("agent"));
    const pending = queue.drainBeforeSettle();
    queue.cancel("agent");
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual([]);
  });

  it("does not wait for agents that have not yet completed", async () => {
    const pending = queue.drainBeforeSettle();
    queue.schedule("late", () => message("late"));
    expect(await pending).toEqual([]);
  });

  it("suppresses aborted boundary waits and retains pending results", async () => {
    const controller = new AbortController();
    queue.schedule("agent", () => message("agent"));
    const pending = queue.drainBeforeSettle(controller.signal);
    controller.abort();
    expect(await pending).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(await queue.drainBeforeSettle()).toEqual([message("agent")]);
  });

  it("notifies promptly after the hold when the parent is already idle", () => {
    idle = true;
    queue.schedule("agent", () => message("agent"));
    vi.advanceTimersByTime(199);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(message("agent"));
  });

  it("does not restart a parent that goes idle before a busy-origin hold expires", async () => {
    queue.schedule("agent", () => message("agent"));
    vi.advanceTimersByTime(100);
    idle = true;
    vi.advanceTimersByTime(100);
    expect(send).not.toHaveBeenCalled();
    expect(await queue.drainBeforeSettle()).toEqual([message("agent")]);
  });

  it("drops busy-origin notifications during navigation before hold expiry", () => {
    queue.schedule("agent", () => message("agent"));
    vi.advanceTimersByTime(100);
    idle = true;
    vi.advanceTimersByTime(100);
    queue.dispose();
    expect(send).not.toHaveBeenCalled();
  });

  it("replaces an older callback with the same key", () => {
    idle = true;
    queue.schedule("agent", () => message("old"));
    vi.advanceTimersByTime(100);
    queue.schedule("agent", () => message("new"));
    idle = true;
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledExactlyOnceWith(message("new"));
  });

  it("isolates a stale completion from other results at the boundary", async () => {
    queue.schedule("stale", () => { throw new Error("stale completion"); });
    queue.schedule("valid", () => message("valid"));
    vi.advanceTimersByTime(200);
    expect(await queue.drainBeforeSettle()).toEqual([message("valid")]);
  });

  it("does not let a stale idle delivery throw out of a timer", () => {
    idle = true;
    send.mockImplementation(() => { throw new Error("stale context"); });
    queue.schedule("stale", () => message("stale"));
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops pending completions on shutdown and rejects late callbacks", async () => {
    queue.schedule("agent", () => message("agent"));
    const pending = queue.drainBeforeSettle();
    queue.dispose();
    idle = true;
    queue.schedule("late", () => message("late"));
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
