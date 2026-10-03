import { fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentCall, agentToolResults, type ManagerHandle, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

/** Real Pi sessions, scripted provider; no remote models or credentials. */
describe("no stale completion after the final answer (real host)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => { await run?.dispose(); run = undefined; });

  for (const count of [1, 2]) {
    it(`${count === 1 ? "individual" : "grouped"}: late consumption leaves the main summary last`, async () => {
      let parentTurns = 0;
      let joined = false;
      run = await runPrintMode({
        prompt: "Run workers, retrieve results later, then summarize.",
        respond: async ctx => {
          if (!getCurrentTools(ctx.messages).some(t => t.name === "Agent")) return "WORKER_RESULT";
          parentTurns++;
          if (parentTurns === 1) {
            return Array.from({ length: count }, (_, i) => agentCall({
              prompt: "Return WORKER_RESULT", description: `worker ${i}`, run_in_background: true,
            }, { id: `spawn-${i}` }));
          }
          if (parentTurns === 2) {
            const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as ManagerHandle;
            await manager.waitForAll();
            await new Promise(resolve => setTimeout(resolve, 500)); // well past 200ms nudge hold
            const results = ctx.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
            return results.map((m, i) => {
              const text = m.content.map(c => c.type === "text" ? c.text : "").join("");
              const id = /Agent ID: (\S+)/.exec(text)?.[1];
              expect(id).toBeTruthy();
              return fauxToolCall("get_subagent_result", { agent_id: id }, { id: `join-${i}` });
            });
          }
          joined = ctx.messages.filter(m => m.role === "toolResult" && m.toolName === "get_subagent_result")
            .filter(m => JSON.stringify(m.content).includes("WORKER_RESULT")).length === count;
          return "MAIN_SUMMARY";
        },
      });
      await new Promise(resolve => setTimeout(resolve, 300)); // settle-time delivery gets a chance
      await run.parentSession.waitForIdle();
      expect(agentToolResults(run.parentSession), JSON.stringify(run.parentSession.messages)).toHaveLength(count);
      expect(joined).toBe(true);
      expect(parentTurns).toBe(3);
      expect(run.parentSession.messages.filter(m => m.role === "custom" && m.customType === "subagent-notification"))
        .toHaveLength(0);
      expect(run.parentSession.getLastAssistantText()).toBe("MAIN_SUMMARY");
    }, 30_000);
  }
});
