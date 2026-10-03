import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";
import type * as OutputFileModule from "../src/output-file.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof OutputFileModule>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/test-resume.output"),
    writeInitialEntry: vi.fn(), ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";

/** Real Agent tool -> manager.resume -> completion queue, with only the runner deferred. */
describe("completion notifications across accepted resumes", () => {
  type Hook = (event: { type: string }, ctx: ExtensionContext) => unknown;
  let cwd: string;
  let previousCwd: string;
  let tools: Map<string, ToolDefinition>;
  let hooks: Map<string, Hook[]>;
  let sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>;
  let ctx: ExtensionContext;
  let idle: boolean;
  let settledMessages: string[];
  let spawns: Array<() => void>;
  let resumes: Array<() => void>;

  const drain = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await drain(); };
  const emit = async (name: string) => {
    for (const hook of hooks.get(name) ?? []) await hook({ type: name }, ctx);
  };
  const settle = async () => {
    idle = true;
    const pending = Promise.all((hooks.get("agent_before_settle") ?? []).map(hook =>
      hook({ type: "agent_before_settle", outcome: "completed", entries: [] }, ctx)));
    await advance(1_000); // time may have been reset for the same-millisecond case
    for (const outcome of await pending) {
      const response = outcome as { entries?: Array<{ content: string }> } | undefined;
      settledMessages.push(...response?.entries?.map(entry => entry.content) ?? []);
    }
  };
  const textOf = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) =>
    result.content.map(block => block.type === "text" ? block.text : "").join("");
  const spawn = async () => {
    const result = await tools.get("Agent")!.execute("spawn-call", {
      prompt: "initial", description: "generation regression", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, ctx);
    const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
    expect(id).toBeDefined();
    await drain();
    return id!;
  };
  const resume = (id: string, background = true) => tools.get("Agent")!.execute("resume-call", {
    prompt: "again", description: "generation regression", subagent_type: "general-purpose",
    resume: id, run_in_background: background,
  }, undefined, undefined, ctx);
  const messages = () => [...settledMessages, ...sendMessage.mock.calls.map(([message]) => message.content)];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    cwd = mkdtempSync(join(tmpdir(), "pi-resume-generation-"));
    previousCwd = process.cwd();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }));
    process.chdir(cwd);
    tools = new Map(); hooks = new Map(); sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    spawns = []; resumes = []; idle = false; settledMessages = [];
    const session = { messages: [], dispose: vi.fn() } as unknown as AgentSession;
    ctx = {
      hasUI: false, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() }, cwd,
      model: undefined, modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: () => "regression", getBranch: () => [] },
      getSystemPrompt: () => "parent", isIdle: () => idle,
    } as unknown as ExtensionContext;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      const run = spawns.length + 1;
      spawns.push(() => resolve({ responseText: `SPAWN_${run}`, session, aborted: false, steered: false }));
    }));
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
      const run = resumes.length + 1;
      resumes.push(() => resolve({ text: `RESUME_${run}` }));
    }));
    const pi = {
      registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerCommand: vi.fn(),
      registerFlag: vi.fn(), getFlag: vi.fn(), registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      on: (name: string, handler: Hook) => hooks.set(name, [...hooks.get(name) ?? [], handler]),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage,
    };
    subagentsExtension(pi as unknown as ExtensionAPI);
    await emit("agent_start");
  });

  afterEach(async () => {
    for (const finish of [...spawns, ...resumes]) finish();
    await drain();
    await emit("session_shutdown");
    vi.useRealTimers();
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("invalidates an individual completion on background resume, even within the same millisecond", async () => {
    const id = await spawn();
    spawns[0](); await drain();
    const completedAt = Date.now();
    await advance(250);
    vi.setSystemTime(completedAt); // timestamps alone cannot distinguish the two runs
    const resumed = await resume(id);
    expect(textOf(resumed)).toContain("resumed in background");
    const registry = (globalThis as unknown as Record<symbol, { getRecord: (id: string) => AgentRecord }>)[Symbol.for("pi-subagents:manager")];
    expect(registry.getRecord(id).startedAt).toBe(completedAt);
    expect(registry.getRecord(id).generation).toBe(1);
    expect(resumes).toHaveLength(1);
    await settle();
    expect(messages()).toEqual([]);
    resumes[0](); await drain(); await advance(400);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("RESUME_1");
    expect(messages()[0]).not.toContain("SPAWN_1");
  });

  it("invalidates the old completion on a foreground resume without notifying for the inline result", async () => {
    const id = await spawn();
    spawns[0](); await drain(); await advance(250);
    const pending = resume(id, false);
    expect(resumes).toHaveLength(1);
    await settle();
    expect(messages()).toEqual([]);
    resumes[0]();
    expect(textOf(await pending)).toContain("RESUME_1");
    await advance(300);
    expect(messages()).toEqual([]);
  });

  it("invalidates immediately when background resume is queued, before it starts", async () => {
    const id = await spawn();
    spawns[0](); await drain(); await advance(250);
    const blocker = await spawn();
    expect(spawns).toHaveLength(2);
    expect(textOf(await resume(id))).toContain("queued");
    expect(resumes).toHaveLength(0);
    await settle();
    expect(messages()).toEqual([]);
    spawns[1](); await drain();
    expect(resumes).toHaveLength(1);
    resumes[0](); await drain(); await advance(400);
    expect(messages().filter(content => content.includes(id))).toHaveLength(1);
    expect(messages().join("\n")).toContain("RESUME_1");
    expect(blocker).not.toBe(id);
  });

  it.each(["running", "queued"])("rejects foreground re-entry of a %s resume without changing its generation", async status => {
    const id = await spawn();
    spawns[0](); await drain(); await advance(250);
    if (status === "queued") await spawn();
    expect(textOf(await resume(id))).toContain(status === "queued" ? "queued" : "resumed in background");
    const registry = (globalThis as unknown as Record<symbol, { getRecord: (id: string) => AgentRecord }>)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(id);
    expect(record.status).toBe(status);
    const generation = record.generation;
    const controller = record.abortController;
    expect(textOf(await resume(id, false))).toContain("Failed to resume");
    expect(record.status).toBe(status);
    expect(record.generation).toBe(generation);
    expect(record.abortController).toBe(controller);
    expect(resumes).toHaveLength(status === "queued" ? 0 : 1);
  });

  it("does not let an unfinished old group claim its member's queued resume", async () => {
    const first = await spawn();
    const second = await spawn();
    await advance(101); // group forms before either child completes
    spawns[0](); await drain();
    expect(spawns).toHaveLength(2);
    expect(textOf(await resume(first))).toContain("queued");
    expect(resumes).toHaveLength(0);
    spawns[1](); await drain(); // old group delivers; resumed run starts
    expect(resumes).toHaveLength(1);
    await advance(250);
    await settle();
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain(second);
    expect(messages()[0]).not.toContain(first);
    resumes[0](); await drain(); await advance(400);
    expect(messages().filter(content => content.includes(first))).toHaveLength(1);
    expect(messages().filter(content => content.includes(first))[0]).toContain("RESUME_1");
  });

  it("does not let a held old group include or duplicate a resumed member", async () => {
    const first = await spawn();
    const second = await spawn(); // queued behind first, still included in smart batch
    await advance(101); // register the group
    spawns[0](); await drain();
    expect(spawns).toHaveLength(2);
    spawns[1](); await drain(); // group callback now holds both records
    await advance(250);
    expect(messages()).toEqual([]);
    await resume(first);
    await settle();
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain(second);
    expect(messages()[0]).not.toContain(first);
    resumes[0](); await drain(); await advance(101); // resumed batch finalizes
    await advance(250);
    expect(messages().filter(content => content.includes(first))).toHaveLength(1);
    expect(messages().filter(content => content.includes(first))[0]).toContain("RESUME_1");
  });
});
