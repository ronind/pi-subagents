import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline provider loaded by the real CLI, not the session-only test runner. */
export default function completionProvider(pi: ExtensionAPI) {
  const count = Number(process.env.COMPLETION_TEST_COUNT ?? "1");
  const consume = process.env.COMPLETION_TEST_CONSUME === "1";
  const faux = createFauxCore({ provider: "completion-fixture", models: [{ id: "scripted" }] });
  let parentTurns = 0;
  faux.setResponses(Array.from({ length: 16 }, () => async context => {
    if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
      return fauxAssistantMessage("CLI_WORKER_RESULT");
    }
    parentTurns++;
    if (parentTurns === 1) {
      return fauxAssistantMessage(Array.from({ length: count }, (_, i) => fauxToolCall("Agent", {
        prompt: "Return CLI_WORKER_RESULT", description: `worker ${i}`,
        subagent_type: "general-purpose", run_in_background: true,
      }, { id: `spawn-${i}` })), { stopReason: "toolUse" });
    }
    if (parentTurns === 2) {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        waitForAll(): Promise<void>;
      };
      await manager.waitForAll();
      await new Promise(resolve => setTimeout(resolve, 350)); // past the original hold
      if (consume) {
        const results = context.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
        return fauxAssistantMessage(results.map((result, i) => {
          const text = result.content.map(c => c.type === "text" ? c.text : "").join("");
          const id = /Agent ID: (\S+)/.exec(text)?.[1];
          if (!id) throw new Error(`Missing spawned agent ID: ${text}`);
          return fauxToolCall("get_subagent_result", { agent_id: id }, { id: `read-${i}` });
        }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("INITIAL_SUMMARY");
    }
    const sawResults = JSON.stringify(context.messages).includes("CLI_WORKER_RESULT");
    return fauxAssistantMessage(sawResults ? "FINAL_SUMMARY_WITH_RESULTS" : "MISSING_RESULTS");
  }));
  pi.registerProvider("completion-fixture", {
    api: faux.api, apiKey: "offline-fixture", baseUrl: "https://example.invalid",
    streamSimple: faux.streamSimple, models: faux.models,
  });
}
