import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest: {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
} = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

describe("host-provided extension dependencies", () => {
  it.each(hostPackages)("declares %s as a peer, not a runtime dependency", (name) => {
    expect(manifest.dependencies[name]).toBeUndefined();
    expect(manifest.peerDependencies[name]).toBeDefined();
  });

  it.each(["@sinclair/typebox", "typebox"])("accepts the host's %s version", (name) => {
    expect(manifest.peerDependencies[name]).toBe("*");
  });
});
