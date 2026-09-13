import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";
import { getDefaultMaxTurns, getRememberAgents, runAgent } from "../src/agent-runner.js";
import { getAgentConfig } from "../src/agent-types.js";
import type { SubagentHostReady } from "../src/host-observation.js";
import extension from "../src/index.js";
import { getMaxSubagentDepth } from "../src/nested-tools.js";
import { abortableRun } from "./helpers/abortable-run.js";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof AgentRunner>("../src/agent-runner.js"), runAgent: vi.fn(),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()));
  vi.clearAllMocks();
});

function root(name: string, maxTurns: number) {
  let sessionId = name;
  const cwd = mkdtempSync(join(tmpdir(), "subagent-root-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "shared.md"), `---\ndescription: ${name}\ntools: none\nextensions: false\n---\n${name} instructions`);
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
    defaultMaxTurns: maxTurns, rememberAgents: false, maxSubagentDepth: maxTurns, schedulingEnabled: false, outputTranscript: false,
  }));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, ((event: unknown) => void)[]>();
  const emitted: [string, unknown][] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    getAllTools: () => [], getActiveTools: () => [],
    appendEntry: vi.fn(), sendMessage: vi.fn(),
    events: {
      on: (event: string, listener: (event: unknown) => void) => {
        events.set(event, [...events.get(event) ?? [], listener]);
        return () => events.set(event, (events.get(event) ?? []).filter(fn => fn !== listener));
      },
      emit: (event: string, value: unknown) => { emitted.push([event, value]); for (const fn of events.get(event) ?? []) fn(value); },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, hasUI: false, model: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] }, getSystemPrompt: () => name,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  extension(pi);
  cleanup.push(async () => { await handlers.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); });
  return {
    pi, ctx, tools, emitted,
    start: () => handlers.get("session_start")?.({}, ctx),
    switchSession: (next: string) => { sessionId = next; return handlers.get("session_start")?.({}, ctx); },
    get ready() { return emitted.findLast(([name]) => name === "subagents:host:ready")?.[1] as SubagentHostReady | undefined; },
    spawn: () => tools.get("Agent")!.execute(`call-${name}`, { description: name, subagent_type: "shared", prompt: name, run_in_background: true }, undefined, undefined, ctx),
  };
}

it("keeps same-name agent configuration isolated across two GUI roots and awaited callbacks", async () => {
  const first = root("first", 3);
  const second = root("second", 7);
  await first.start();
  await second.start();
  const observed: unknown[] = [];
  vi.mocked(runAgent).mockImplementation(async (ctx, type) => {
    await Promise.resolve();
    observed.push({ cwd: ctx.cwd, type, prompt: getAgentConfig(type)?.systemPrompt, turns: getDefaultMaxTurns(), remembered: getRememberAgents(), depth: getMaxSubagentDepth() });
    return { responseText: "done", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false };
  });
  await Promise.all([first.spawn(), second.spawn()]);
  expect(observed).toEqual([
    { cwd: first.ctx.cwd, type: "shared", prompt: "first instructions", turns: 3, remembered: false, depth: 3 },
    { cwd: second.ctx.cwd, type: "shared", prompt: "second instructions", turns: 7, remembered: false, depth: 7 },
  ]);
  expect(first.ready?.rootSessionId).toBe("first");
  expect(second.ready?.rootSessionId).toBe("second");
  expect(first.ready?.provider).not.toBe(second.ready?.provider);
  expect(first.ready?.provider.snapshot().every(record => record.rootSessionId === "first")).toBe(true);
});

it("does not let a provider retained across session switches stop the new root", async () => {
  const host = root("old-root", 3);
  await host.start();
  vi.mocked(runAgent).mockImplementation(abortableRun);
  await host.spawn();
  const previous = host.ready!.provider;
  const oldEvents: unknown[] = [];
  previous.subscribe(event => oldEvents.push(event));

  await host.switchSession("next-root");
  const current = host.ready!.provider;
  oldEvents.length = 0;
  await host.spawn();
  await previous.stop();
  await previous.close();
  expect(current).not.toBe(previous);
  expect(current.snapshot()).toEqual([expect.objectContaining({ rootSessionId: "next-root", status: "running" })]);
  expect(previous.snapshot().every(record => record.rootSessionId === "old-root")).toBe(true);
  expect(oldEvents).toEqual([]);
});

it("defers strict project validation until the actual session cwd is known", async () => {
  const foreign = mkdtempSync(join(tmpdir(), "subagent-foreign-"));
  mkdirSync(join(foreign, ".pi", "agents"), { recursive: true });
  writeFileSync(join(foreign, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));
  writeFileSync(join(foreign, ".pi", "agents", "invalid.md"), "---\ndescription: invalid: yaml\n---\n");
  const originalCwd = process.cwd();
  let host: ReturnType<typeof root>;
  try {
    process.chdir(foreign);
    host = root("valid-project", 3);
  } finally {
    process.chdir(originalCwd);
    rmSync(foreign, { recursive: true, force: true });
  }
  await host.start();
  expect(host.ready?.rootSessionId).toBe("valid-project");
});

it("host close is idempotent, suppresses pending follow-ups, and permanently refuses spawns", async () => {
  const host = root("closing", 3);
  await host.start();
  const dispose = vi.fn();
  vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose } as unknown as AgentSession, aborted: false, steered: false });
  await host.spawn();
  expect(host.ready).toBeDefined();
  const provider = host.ready!.provider;
  await Promise.all([provider.close(), provider.close()]);
  expect(dispose).toHaveBeenCalledOnce();
  expect(host.pi.sendMessage).not.toHaveBeenCalled();
  await expect(host.spawn()).rejects.toThrow(/clos/i);
});
