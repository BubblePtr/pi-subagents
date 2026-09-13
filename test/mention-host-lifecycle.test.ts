import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { type AgentSession, type AgentSessionEvent, createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import type { SubagentHostEvent, SubagentHostReady } from "../src/host-observation.js";
import extension from "../src/index.js";
import { abortableRun } from "./helpers/abortable-run.js";
import { ctx, flush, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
  ...await vi.importActual<typeof PiCodingAgent>("@earendil-works/pi-coding-agent"), createAgentSession: vi.fn(),
}));
vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof AgentRunner>("../src/agent-runner.js"), runAgent: vi.fn(),
}));

const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  releases.push(resolve);
  return { promise, resolve };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(cleanups.splice(0).map(fn => fn()));
  vi.clearAllMocks();
});

async function boot() {
  const dir = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false } });
  const b = makePi();
  const context = ctx({ mode: "rpc" });
  context.sessionManager.getEntries = () => [];
  context.sessionManager.getLeafId = () => null;
  extension(b.pi);
  await b.lifecycle.get("session_start")({}, context);
  const ready = b.pi.events.emit.mock.calls.find((call: unknown[]) => call[0] === "subagents:host:ready")[1] as SubagentHostReady;
  const events: SubagentHostEvent[] = [];
  ready.provider.subscribe(event => events.push(event));
  cleanups.push(async () => {
    await b.lifecycle.get("session_shutdown")({}, context);
    dir.restore();
  });
  return { ...b, context, provider: ready.provider, events,
    mention: () => b.lifecycle.get("input")({ source: "interactive", text: "@explore find the failing check" }, context),
  };
}

function clone(turn: (tool: ToolDefinition, emit: (event: AgentSessionEvent) => void) => Promise<void>, creation = Promise.resolve()) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let tool!: ToolDefinition;
  const child = {
    agent: { state: { systemPrompt: "", messages: [] } },
    model: { provider: "fake", id: "planner" }, thinkingLevel: "low",
    subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: vi.fn(async () => {}), steer: vi.fn(async () => {}), dispose: vi.fn(),
    prompt: vi.fn(async () => turn(tool, event => { for (const listener of listeners) listener(event); })),
  } as unknown as AgentSession;
  vi.mocked(createAgentSession).mockImplementation(async opts => {
    tool = opts!.customTools![0];
    await creation;
    Object.assign(child, { sessionManager: opts!.sessionManager, sessionId: opts!.sessionManager!.getSessionId() });
    return { session: child } as Awaited<ReturnType<typeof createAgentSession>>;
  });
  return child;
}

it.each(["stop", "close"] as const)("owns the default @agent planner during SDK creation and %s prevents its prompt", async method => {
  const host = await boot();
  const creating = gate();
  const child = clone(async () => {}, creating.promise);
  await host.mention();
  expect(host.provider.snapshot()).toEqual([expect.objectContaining({ type: "mention-planner", status: "running", rootSessionId: "s1" })]);
  let stopped = false;
  const stopping = host.provider[method]().then(() => { stopped = true; });
  await flush();
  expect(stopped).toBe(false);
  expect(host.provider.snapshot()[0].status).toBe("stopping");
  creating.resolve();
  await stopping;
  await flush();
  expect(child.prompt).not.toHaveBeenCalled();
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(runAgent).not.toHaveBeenCalled();
  expect(host.events.at(-1)).toMatchObject({ type: "released", record: { type: "mention-planner", status: "stopped" } });
  expect(host.pi.sendMessage).not.toHaveBeenCalled();
  if (method === "close") {
    await host.provider.close();
    expect(child.dispose).toHaveBeenCalledOnce();
  }
});

it("cancels a running planner, rejects its late Agent call, and never falls back after stop", async () => {
  const host = await boot();
  const entered = gate();
  const finish = gate();
  let lateTool!: ToolDefinition;
  const child = clone(async tool => { lateTool = tool; entered.resolve(); await finish.promise; });
  await host.mention();
  await entered.promise;
  const stopping = host.provider.stop();
  expect(child.abort).toHaveBeenCalledOnce();
  await expect(lateTool.execute("late", { prompt: "late", subagent_type: "Explore" }, undefined, undefined, host.context)).rejects.toThrow(/abort/i);
  finish.resolve();
  await stopping;
  await flush();
  await expect(lateTool.execute("after-stop", { prompt: "late", subagent_type: "Explore" }, undefined, undefined, host.context)).rejects.toThrow(/abort/i);
  expect(runAgent).not.toHaveBeenCalled();
  expect(host.pi.sendMessage).not.toHaveBeenCalled();
  expect(child.dispose).toHaveBeenCalledOnce();
  const newTurn = gate();
  const newFinish = gate();
  clone(async () => { newTurn.resolve(); await newFinish.promise; });
  await host.mention();
  await newTurn.promise;
  expect(host.provider.snapshot()).toEqual([expect.objectContaining({ type: "mention-planner", status: "running" })]);
  const stopNew = host.provider.stop();
  newFinish.resolve();
  await stopNew;
});

it("observes planner trace and own usage, then transfers the real agent to the root", async () => {
  const host = await boot();
  let observedBeforePrompt = false;
  host.provider.subscribe(event => {
    if (event.type === "session" && event.record.type === "mention-planner") {
      observedBeforePrompt = true;
      event.session.subscribe(trace => { if (trace.type === "message_end") traces.push(trace); });
    }
  });
  const traces: AgentSessionEvent[] = [];
  vi.mocked(runAgent).mockImplementation(abortableRun);
  const child = clone(async (tool, emit) => {
    expect(observedBeforePrompt).toBe(true);
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Delegate the check investigation." }],
      api: "openai-completions", provider: "fake", model: "planner", timestamp: 0, stopReason: "stop",
      usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 19,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
    } });
    emit({ type: "tool_execution_start", toolCallId: "planner-call", toolName: "Agent", args: {} });
    const result = await tool.execute("planner-call", { subagent_type: "Explore", prompt: "investigate", description: "Investigate failure" }, undefined, undefined, host.context);
    emit({ type: "tool_execution_end", toolCallId: "planner-call", toolName: "Agent", result, isError: false });
  });
  await host.mention();
  await flush();
  expect(traces).toHaveLength(1);
  expect(host.events.find(event => event.type === "released" && event.record.type === "mention-planner")).toMatchObject({
    record: { status: "completed", toolUses: 1, result: "Delegate the check investigation.", usage: { input: 12, output: 4, cost: { total: 0.3 } } },
  });
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(host.provider.snapshot()).toEqual([expect.objectContaining({ type: "Explore", rootSessionId: "s1", parentAgentId: undefined, status: "running" })]);
  await host.provider.stop();
  expect(host.provider.snapshot()[0].status).toBe("stopped");
});

it("delivers steering queued while the planner SDK session is being created", async () => {
  const host = await boot();
  const creating = gate();
  const entered = gate();
  const finish = gate();
  const child = clone(async () => { entered.resolve(); await finish.promise; }, creating.promise);
  await host.mention();
  await host.provider.steer!(host.provider.snapshot()[0].id, "Focus on the latest failure");
  creating.resolve();
  await entered.promise;
  expect(child.steer).toHaveBeenCalledWith("Focus on the latest failure");
  const stopping = host.provider.stop();
  finish.resolve();
  await stopping;
});
