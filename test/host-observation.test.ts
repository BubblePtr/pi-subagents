import type { AgentSession, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { SubagentHostEvent } from "../src/host-observation.js";
import { createWorktree } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}), isWorktreeIsolationEnabled: () => true,
}));

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "root-a" } } as ExtensionContext;
function session(id: string) {
  return {
    sessionId: id, model: { provider: "faux", id: "test" }, thinkingLevel: "low",
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/tmp/${id}.jsonl`, getCwd: () => "/tmp" },
    dispose: vi.fn(), steer: vi.fn(async () => {}),
  } as unknown as AgentSession;
}

describe("host observation and task ownership", () => {
  const managers: AgentManager[] = [];
  const releases: (() => void)[] = [];
  const createManager = (limit = 10) => {
    const manager = new AgentManager(undefined, limit);
    managers.push(manager);
    return manager;
  };
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.all(managers.splice(0).map(manager => manager.dispose()));
    vi.clearAllMocks();
  });

  it("publishes nested and workflow sessions before their first prompt and emits own usage only", async () => {
    const manager = createManager();
    const events: SubagentHostEvent[] = [];
    const observed = new Set<string>();
    const unsubscribe = manager.subscribeHost(event => {
      events.push(event);
      if (event.type === "session") observed.add(event.session.sessionId);
    });
    const release = gate();
    releases.push(() => release.resolve());
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      await Promise.resolve();
      const child = session(prompt);
      opts.onSessionCreated?.(child);
      expect(observed.has(prompt)).toBe(true);
      opts.onToolActivity?.({ type: "start", toolName: "read" });
      opts.onAssistantUsage?.({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: 0.25 });
      await release.promise;
      opts.onToolActivity?.({ type: "end", toolName: "read" });
      return { responseText: prompt, session: child, aborted: false, steered: false };
    });
    const root = manager.spawn(pi, ctx, "same-name", "parent", { description: "parent", toolCallId: "call-parent" });
    const child = manager.spawn(pi, ctx, "same-name", "nested", { description: "nested", parentAgentId: root });
    const workflow = manager.spawn(pi, ctx, "same-name", "workflow", { description: "workflow", workflowId: "wf-test" });
    await Promise.all([root, child, workflow].map(id => manager.awaitStartup(id)));
    expect(events.filter(event => event.type === "session").map(event => event.record.id)).toEqual([root, child, workflow]);
    manager.getRecord(root)!.lifetimeUsage.input += 999;
    expect(manager.snapshotHost().find(record => record.id === root)).toMatchObject({
      rootSessionId: "root-a", sessionId: "parent", toolCallId: "call-parent", currentTool: "read",
      model: { provider: "faux", id: "test" }, usage: { input: 11, output: 7, cacheRead: 3, cost: { total: 0.25 } },
    });
    release.resolve();
    await manager.waitForAll();
    expect(events.some(event => event.type === "record" && event.record.id === workflow && event.record.status === "completed")).toBe(true);
    unsubscribe();
  });

  it("includes new compaction and branch-summary spend without inherited or tool-result usage", async () => {
    const manager = createManager();
    const events: SubagentHostEvent[] = [];
    manager.subscribeHost(event => events.push(event));
    const usage = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, totalTokens: n * 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n } });
    const summary = (id: string, n: number): SessionEntry => ({
      id, parentId: null, timestamp: "2026-09-13T00:00:00Z", type: "compaction",
      summary: id, tokensBefore: 100, firstKeptEntryId: "first", usage: usage(n),
    });
    const entries = [summary("inherited", 100)];
    const child = session("summary");
    child.sessionManager.getEntries = () => entries;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      opts.onSessionAllocated?.(child);
      opts.onSessionCreated?.(child);
      opts.onAssistantUsage?.({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 });
      entries.push(summary("own-compaction", 2), {
        id: "own-branch", parentId: null, timestamp: "2026-09-13T00:00:01Z",
        type: "branch_summary", fromId: "first", summary: "branch", usage: usage(3),
      }, {
        id: "nested-tool", parentId: null, timestamp: "2026-09-13T00:00:02Z", type: "message",
        message: { role: "toolResult", toolCallId: "nested", toolName: "Agent", content: [], isError: false, timestamp: 0, usage: usage(1000) },
      });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 100 });
      expect(events.at(-1)?.record.usage?.cost.total).toBe(6);
      return { responseText: "done", session: child, aborted: false, steered: false };
    });
    await manager.spawnAndWait(pi, ctx, "type", "task", { description: "summaries" });
    expect(manager.snapshotHost()[0]?.usage).toEqual({ input: 6, output: 6, cacheRead: 6, cacheWrite: 6, cost: { total: 6 } });
  });

  it("keeps a stopped tree stopping until its work settles, while its sibling keeps running", async () => {
    const manager = createManager();
    const started = new Map<string, AbortSignal>();
    const finish = gate();
    releases.push(() => finish.resolve());
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      started.set(prompt, opts.signal!);
      await finish.promise;
      return { responseText: prompt, session: session(prompt), aborted: false, steered: false };
    });
    const parent = manager.spawn(pi, ctx, "type", "parent", { description: "parent" });
    const child = manager.spawn(pi, ctx, "type", "child", { description: "child", parentAgentId: parent });
    const sibling = manager.spawn(pi, ctx, "type", "sibling", { description: "sibling" });
    let stopped = false;
    const stopping = manager.stop(parent).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(started.get("parent")?.aborted).toBe(true);
    expect(started.get("child")?.aborted).toBe(true);
    expect(started.get("sibling")?.aborted).toBe(false);
    expect(manager.snapshotHost().find(record => record.id === child)?.status).toBe("stopping");
    expect(() => manager.spawn(pi, ctx, "type", "late", { description: "late", parentAgentId: parent })).toThrow(/stopp|clos/i);
    finish.resolve();
    await stopping;
    expect(manager.snapshotHost().find(record => record.id === parent)?.status).toBe("stopped");
    expect(manager.getRecord(sibling)?.status).toBe("completed");
  });

  it("releases an evicted session with its final identity after disposal", async () => {
    const manager = createManager();
    const child = session("evicted");
    const events: SubagentHostEvent[] = [];
    manager.subscribeHost(event => {
      if (event.type === "released") expect(child.dispose).toHaveBeenCalledOnce();
      events.push(event);
    });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      opts.onSessionCreated?.(child);
      return { responseText: "final", session: child, aborted: false, steered: false };
    });
    await manager.spawnAndWait(pi, ctx, "type", "done", { description: "eviction" });
    expect(events.some(event => event.type === "released")).toBe(false);
    manager.clearCompleted();
    await Promise.resolve();
    expect(events.at(-1)).toMatchObject({ type: "released", record: {
      sessionId: "evicted", rootSessionId: "root-a", status: "completed", result: "final",
    } });
  });

  it("cancels queued work and waits for worktree initialization before stop resolves", async () => {
    const manager = createManager(1);
    const copied = gate<Awaited<ReturnType<typeof createWorktree>>>();
    releases.push(() => copied.resolve(undefined));
    vi.mocked(createWorktree).mockReturnValue(copied.promise);
    const first = manager.spawn(pi, ctx, "type", "first", { description: "first", isolation: "worktree", isBackground: true });
    const queued = manager.spawn(pi, ctx, "type", "queued", { description: "queued", isBackground: true });
    let stopped = false;
    const stopping = manager.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(() => manager.spawn(pi, ctx, "type", "late", { description: "late" })).toThrow(/stopp/i);
    copied.resolve({ path: "/tmp/copy", workPath: "/tmp/copy", baseSha: "sha", branch: "branch" });
    await stopping;
    expect(runAgent).not.toHaveBeenCalled();
    expect(manager.snapshotHost().filter(record => [first, queued].includes(record.id)).every(record => record.status === "stopped")).toBe(true);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "new", session: session("new"), aborted: false, steered: false });
    expect(() => manager.spawn(pi, ctx, "type", "new", { description: "new" })).not.toThrow();
  });

  it("waits for an eviction already shutting down when the root closes", async () => {
    const manager = createManager();
    const released = gate();
    releases.push(() => released.resolve());
    const child = Object.assign(session("releasing"), {
      extensionRunner: { hasHandlers: () => true, emit: () => released.promise },
    }) as unknown as AgentSession;
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: child, aborted: false, steered: false });
    await manager.spawnAndWait(pi, ctx, "type", "done", { description: "release pending" });
    manager.clearCompleted();
    let closed = false;
    const closing = manager.dispose().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    released.resolve();
    await closing;
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])("observes and stops resumed work (background=%s)", async (background) => {
    const manager = createManager();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: session("kept"), aborted: false, steered: false });
    const { id } = await manager.spawnAndWait(pi, ctx, "type", "first", { description: "first" });
    const observed: SubagentHostEvent[] = [];
    manager.subscribeHost(event => observed.push(event));
    const resumed = gate();
    releases.push(() => resumed.resolve());
    let resumedSignal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation(async (child, _prompt, opts) => {
      expect(observed.some(event => event.type === "session" && event.session === child)).toBe(true);
      resumedSignal = opts?.signal;
      await resumed.promise;
      return { text: "second" };
    });
    const result = manager.resume(id, "second", undefined, { isBackground: background });
    const stopped = manager.stop(id);
    expect(resumedSignal?.aborted).toBe(true);
    resumed.resolve();
    await Promise.all([result, stopped]);
    expect(manager.snapshotHost()[0]?.status).toBe("stopped");
  });

  it("publishes a queued resume and allows its observer to cancel it before launch", async () => {
    const manager = createManager(1);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: session("kept"), aborted: false, steered: false });
    const { id } = await manager.spawnAndWait(pi, ctx, "type", "first", { description: "first" });
    const blocker = gate();
    releases.push(() => blocker.resolve());
    vi.mocked(runAgent).mockImplementation(async () => {
      await blocker.promise;
      return { responseText: "blocker", session: session("blocker"), aborted: false, steered: false };
    });
    manager.spawn(pi, ctx, "type", "blocker", { description: "blocker", isBackground: true });
    let stopping: Promise<void> | undefined;
    manager.subscribeHost(event => {
      if (event.record.id === id && event.record.status === "queued") stopping = manager.stop(id);
    });
    await manager.resume(id, "later", undefined, { isBackground: true });
    expect(stopping).toBeDefined();
    await stopping;
    blocker.resolve();
    await manager.waitForAll();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.snapshotHost().find(record => record.id === id)?.status).toBe("stopped");
  });
});
