import type { AgentSession, CustomMessageEntryDraft, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { CompletionNudgeQueue } from "../src/completion-nudge-queue.js";
import { GroupJoinManager } from "../src/group-join.js";
import subagentsExtension from "../src/index.js";

/** Exercise the real extension tools, consumption flags, grouping and hooks. */
describe("individual AND grouped completion delivery", () => {
  type Hook = (event: { type: string }, ctx: ExtensionContext) => unknown;
  let tools: Map<string, ToolDefinition>;
  let hooks: Map<string, Hook[]>;
  let pi: ReturnType<typeof makePi>;
  let ctx: ExtensionContext;
  let idle: boolean;
  let finish: Array<() => void>;
  let settledEntries: CustomMessageEntryDraft[];
  const makePi = () => ({
    registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(),
    registerTool: (t: ToolDefinition) => tools.set(t.name, t),
    registerCommand: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    on: (name: string, handler: Hook) => {
      hooks.set(name, [...hooks.get(name) ?? [], handler]);
    },
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(), sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
  });
  const textOf = (r: Awaited<ReturnType<ToolDefinition["execute"]>>) =>
    r.content.map(c => c.type === "text" ? c.text : "").join("");
  const emit = async (name: string) => {
    for (const handler of hooks.get(name) ?? []) await handler({ type: name }, ctx);
  };
  const drain = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await drain(); };
  const spawn = async (name?: string) => {
    const r = await tools.get("Agent")!.execute("spawn", {
      prompt: "test", description: "completion test", subagent_type: "general-purpose",
      run_in_background: true, name,
    }, undefined, undefined, ctx);
    const text = textOf(r);
    expect(text).toContain("Agent ID:");
    await drain();
    return /Agent ID: (\S+)/.exec(text)![1];
  };
  const consume = (id: string) => tools.get("get_subagent_result")!.execute(
    "read-result", { agent_id: id }, undefined, undefined, ctx,
  );
  const settle = async (outcome: "completed" | "aborted" | "error" = "completed") => {
    const event = { type: "agent_before_settle", outcome, entries: [] as CustomMessageEntryDraft[] };
    for (const handler of hooks.get("agent_before_settle") ?? []) {
      const result = await handler(event, ctx) as { entries?: CustomMessageEntryDraft[]; continue?: boolean } | undefined;
      if (result?.entries) settledEntries.push(...result.entries);
      if (result?.continue) expect(result.entries?.length).toBeGreaterThan(0);
    }
    idle = true;
    await emit("agent_settled");
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    idle = false;
    tools = new Map();
    hooks = new Map();
    finish = [];
    settledEntries = [];
    ctx = {
      hasUI: false,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      cwd: process.cwd(), model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: () => "local-regression", getBranch: () => [] },
      getSystemPrompt: () => "parent", isIdle: () => idle,
    } as unknown as ExtensionContext;
    pi = makePi();
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finish.push(() => resolve({
        responseText: "CHILD_RESULT", session: { dispose: vi.fn() } as unknown as AgentSession,
        aborted: false, steered: false,
      }));
    }));
    subagentsExtension(pi as unknown as ExtensionAPI);
    await emit("agent_start");
  });
  afterEach(async () => {
    for (const done of finish) done();
    await drain();
    await emit("session_shutdown");
    vi.useRealTimers();
  });

  it("suppresses an individual result retrieved seconds after completion", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(textOf(await consume(id))).toContain("CHILD_RESULT");
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toEqual([]);
  });

  it("re-checks individual consumption at delivery even if cancellation was missed", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    // Simulate a missed eager cancellation: the delivery-time check must still
    // exclude a result consumed while the parent was busy.
    const cancel = vi.spyOn(CompletionNudgeQueue.prototype, "cancel").mockImplementation(() => {});
    try {
      expect(textOf(await consume(id))).toContain("CHILD_RESULT");
    } finally {
      cancel.mockRestore();
    }
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toEqual([]);
  });

  it("accepts a handle when consuming a parked individual result", async () => {
    const id = await spawn("notification-test");
    finish[0]();
    await drain();
    await advance(3000);
    const cancel = vi.spyOn(CompletionNudgeQueue.prototype, "cancel");
    try {
      expect(textOf(await consume("notification-test"))).toContain("CHILD_RESULT");
      expect(cancel).toHaveBeenCalledWith(id);
    } finally {
      cancel.mockRestore();
    }
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toEqual([]);
  });

  it("suppresses a fully consumed group", async () => {
    const ids = [await spawn(), await spawn()];
    for (const done of finish) done();
    await drain();
    await advance(3000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    for (const id of ids) await consume(id);
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toEqual([]);
  });

  it("rebuilds a partial group from only the still-unread records", async () => {
    const ids = [await spawn(), await spawn()];
    for (const done of finish) done();
    await drain();
    await advance(3000);
    await consume(ids[0]);
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toHaveLength(1);
    expect(settledEntries[0].content).toContain("1 agent(s) finished");
    expect(settledEntries[0].content).not.toContain(ids[0]);
    expect(settledEntries[0].content).toContain(ids[1]);
  });

  it("still delivers an unread individual result after settle", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    await emit("agent_end");
    await advance(1000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await settle();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(settledEntries).toHaveLength(1);
    expect(settledEntries[0].content).toContain(id);
  });

  it("notifies when an Esc-aborted parent has gone idle before its child finishes", async () => {
    const id = await spawn();
    // Pi skips agent_before_settle on session.abort(). Esc cancels the parent,
    // not a detached child; there is no successful boundary to unlock delivery.
    idle = true;
    await emit("agent_settled");
    await advance(100); // finish smart-join debounce before child completion
    finish[0]();
    await drain();
    await advance(199);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await advance(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(id);
    expect(settledEntries).toEqual([]);
  });

  it("still notifies an idle parent without waiting for another settle", async () => {
    const id = await spawn();
    await settle();
    finish[0]();
    await drain();
    await advance(1000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(id);
  });

  it("drops a consumed partial-timeout batch, but delivers the unread straggler", async () => {
    const ids = [await spawn(), await spawn()];
    await advance(100); // register smart-join group
    finish[0]();
    await drain();
    await advance(31_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await consume(ids[0]);
    finish[1]();
    await drain();
    await advance(1000);
    await settle();
    expect(settledEntries).toHaveLength(1);
    expect(settledEntries[0].content).toContain(ids[1]);
    expect(settledEntries[0].content).not.toContain(ids[0]);
  });

  it("includes completed unread results before CLI shutdown", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    await settle();
    expect(settledEntries[0].content).toContain(id);
    await emit("session_shutdown");
    expect(settledEntries).toHaveLength(1);
  });

  it("clears held group timers on confirmed shutdown", async () => {
    await spawn();
    await spawn();
    await advance(100);
    finish[0]();
    await drain();
    const dispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    try {
      await emit("session_shutdown");
      expect(dispose).toHaveBeenCalledTimes(1);
      await advance(30_000);
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(settledEntries).toEqual([]);
    } finally {
      dispose.mockRestore();
    }
  });

  it("does not deliver during aborted switch or fork teardown", async () => {
    await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    await emit("session_before_switch");
    await settle("aborted");
    await emit("session_shutdown");
    await advance(1000);
    expect(settledEntries).toEqual([]);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not enqueue an unread result at a failed provider outcome", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    await settle("error");
    expect(settledEntries).toEqual([]);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    idle = false;
    await emit("agent_start");
    await settle();
    expect(settledEntries[0].content).toContain(id);
  });

  for (const navigation of ["session_before_switch", "session_before_fork"]) {
    it(`keeps idle notifications working after vetoed ${navigation}`, async () => {
      const id = await spawn();
      await settle();
      await emit(navigation); // veto: no shutdown or new parent run follows
      finish[0]();
      await drain();
      await advance(1000);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendMessage.mock.calls[0][0].content).toContain(id);
    });

    it(`does not flush parked entries during async ${navigation} teardown`, async () => {
      await spawn();
      finish[0]();
      await drain();
      await advance(3000);
      await emit(navigation);
      idle = true;
      await emit("agent_settled"); // abort skips agent_before_settle
      await advance(1000); // another settled handler awaits before shutdown
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(settledEntries).toEqual([]);
      await emit("session_shutdown");
    });
  }

  it("preserves other extensions' boundary entries", async () => {
    await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    const existing: CustomMessageEntryDraft = {
      type: "custom_message", customType: "other-extension", content: "existing", display: false,
    };
    const event = { type: "agent_before_settle", outcome: "completed", entries: [existing] };
    const result = await hooks.get("agent_before_settle")![0](event, ctx) as { entries: CustomMessageEntryDraft[] };
    expect(result.entries).toEqual([existing, expect.objectContaining({ customType: "subagent-notification" })]);
  });

  it("does not latch notifications after vetoed navigation", async () => {
    const id = await spawn();
    finish[0]();
    await drain();
    await advance(3000);
    await emit("session_before_switch"); // another extension vetoes it
    await settle();
    expect(settledEntries[0].content).toContain(id);
  });
});
