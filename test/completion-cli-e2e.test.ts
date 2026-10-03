import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/completion-provider.ts", import.meta.url));
type CliEvent = {
  type: string;
  message?: { role: string; customType?: string; content: unknown };
  entry?: { type: string; customType?: string; content?: unknown };
};

/** Actual CLI printing and disposal; no hold patch, post-prompt wait, or live API. */
describe("completion delivery before single-shot CLI exit", () => {
  let home: string | undefined;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

  for (const count of [1, 2]) {
    for (const consume of [false, true]) {
      it(`JSON: ${count} worker(s), ${consume ? "consumed" : "unread"}`, async () => {
        home = mkdtempSync(join(tmpdir(), "subagents-completion-cli-"));
        const child = exec(process.execPath, [
          cli, "--no-extensions", "-e", provider, "-e", extension,
          "--no-session", "--provider", "completion-fixture", "--model", "scripted",
          "--thinking", "off", "--mode", "json", "-p", "Run workers and summarize their results.",
        ], {
          cwd: home,
          env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home, PI_E2E_LIVE: "0",
            COMPLETION_TEST_COUNT: String(count), COMPLETION_TEST_CONSUME: consume ? "1" : "0" },
          timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        child.child.stdin?.end(); // CLI reads piped stdin before processing -p.
        const { stdout, stderr } = await child;
        const events = stdout.trim().split("\n").map(line => JSON.parse(line) as CliEvent);
        const messages = events.flatMap(event => event.type === "message_end" && event.message ? [event.message] : []);
        const notifications = [
          ...messages.filter(m => m.role === "custom" && m.customType === "subagent-notification"),
          ...events.flatMap(event => event.type === "entry_appended" && event.entry?.type === "custom_message" &&
            event.entry.customType === "subagent-notification" ? [event.entry] : []),
        ];
        expect(notifications, stderr).toHaveLength(consume ? 0 : 1);
        const assistant = messages.filter(m => m.role === "assistant");
        expect(assistant.at(-1)?.content).toEqual([{ type: "text", text: "FINAL_SUMMARY_WITH_RESULTS" }]);
        if (!consume) {
          expect(JSON.stringify(notifications)).toContain("CLI_WORKER_RESULT");
        }
      }, 40_000);
    }
  }

  it("text mode prints the summary incorporating an unread result, not the pre-notification answer", async () => {
    home = mkdtempSync(join(tmpdir(), "subagents-completion-cli-"));
    const child = exec(process.execPath, [
      cli, "--no-extensions", "-e", provider, "-e", extension,
      "--no-session", "--provider", "completion-fixture", "--model", "scripted",
      "--thinking", "off", "-p", "Run a worker and summarize its result.",
    ], {
      cwd: home,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home, PI_E2E_LIVE: "0",
        COMPLETION_TEST_COUNT: "1", COMPLETION_TEST_CONSUME: "0" },
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    child.child.stdin?.end();
    const { stdout } = await child;
    expect(stdout.trim()).toBe("FINAL_SUMMARY_WITH_RESULTS");
  }, 40_000);
});
