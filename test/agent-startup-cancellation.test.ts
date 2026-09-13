import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { type AgentSession, createAgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
  ...await vi.importActual<typeof PiCodingAgent>("@earendil-works/pi-coding-agent"),
  createAgentSession: vi.fn(),
}));
vi.mock("../src/env.js", () => ({ detectEnv: async () => ({ isGitRepo: false, platform: "test" }) }));

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each(["create", "bind"])("does not prompt a child cancelled during %s initialization", async phase => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-cancel-"));
  directories.push(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const prompt = vi.fn(async () => {});
  const child = {
    setSessionName: vi.fn(), messages: [], prompt, abort: vi.fn(async () => {}),
    subscribe: () => () => {},
    bindExtensions: async () => { if (phase === "bind") { reached(); await wait; } },
  } as unknown as AgentSession;
  vi.mocked(createAgentSession).mockImplementation(async () => {
    if (phase === "create") { reached(); await wait; }
    return { session: child } as Awaited<ReturnType<typeof createAgentSession>>;
  });
  const controller = new AbortController();
  const onSessionAllocated = vi.fn();
  const running = runAgent({
    cwd, getSystemPrompt: () => "parent", modelRegistry: { find: () => undefined },
  } as unknown as ExtensionContext, "general-purpose", "write a file", {
    pi: {} as ExtensionAPI, isolated: true, signal: controller.signal, onSessionAllocated,
  });
  const rejected = expect(running).rejects.toThrow(/abort/i);
  await entered;
  controller.abort();
  release();
  await rejected;
  expect(prompt).not.toHaveBeenCalled();
  expect(onSessionAllocated).toHaveBeenCalledExactlyOnceWith(child);
});
