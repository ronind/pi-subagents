import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { expect, it } from "vitest";
import { runMentionClone } from "../src/mention-clone.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

it("the modern host sends the live parent prompt and copied conversation to a mention clone", async () => {
  const home = mkdtempSync(join(tmpdir(), "mention-clone-host-"));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = home;
  const faux = registerFauxProvider({ provider: "mention-clone-fixture", models: [{ id: "scripted" }] });
  try {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const sessionManager = SessionManager.inMemory(home);
    sessionManager.appendMessage({ role: "user", content: "ORIGINAL_CONVERSATION", timestamp: Date.now() });
    let promptSeen = "";
    let historySeen = "";
    let toolsSeen: string[] = [];
    let spawns = 0;
    faux.setResponses([
      context => {
        promptSeen = getCurrentSystemPrompt(context.messages);
        historySeen = JSON.stringify(context.messages);
        toolsSeen = getCurrentTools(context.messages).map(tool => tool.name);
        return fauxAssistantMessage(fauxToolCall("Agent", { prompt: "do the work" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Started the worker."),
    ]);
    const agentTool: ToolDefinition = {
      name: "Agent", label: "Agent", description: "Start a worker", parameters: Type.Object({ prompt: Type.String() }),
      execute: async () => {
        spawns++;
        return { content: [{ type: "text", text: "started" }], details: undefined };
      },
    };
    const ctx = {
      cwd: home, model, sessionManager,
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      getSystemPrompt: () => "EXACT_LIVE_PARENT_PROMPT",
    } as unknown as ExtensionContext;
    expect(await runMentionClone({ ctx, type: "general-purpose", message: "do the work", agentTool })).toEqual({ spawned: true });
    expect(promptSeen).toBe("EXACT_LIVE_PARENT_PROMPT");
    expect(historySeen).toContain("ORIGINAL_CONVERSATION");
    expect(toolsSeen).toEqual(["Agent"]);
    expect(spawns).toBe(1);
  } finally {
    faux.unregister();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
