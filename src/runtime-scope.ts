import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RuntimeScope {
  cwd?: string;
  state: Map<symbol, unknown>;
}

const scopes = new AsyncLocalStorage<RuntimeScope>();
const standaloneScope: RuntimeScope = { state: new Map() };

export function createRuntimeScope(): RuntimeScope { return { state: new Map() }; }
export function getRuntimeScope(): RuntimeScope { return scopes.getStore() ?? standaloneScope; }
export function getRuntimeCwd(): string { return getRuntimeScope().cwd ?? process.cwd(); }
export function inRuntimeScope<T>(scope: RuntimeScope, fn: () => T): T { return scopes.run(scope, fn); }

/** Each setting module retains its own typed defaults; the root owns their lifetime. */
export function runtimeState<T>(key: symbol, create: () => T): T {
  const scope = getRuntimeScope();
  if (!scope.state.has(key)) scope.state.set(key, create());
  return scope.state.get(key) as T;
}

export function bindRuntimeScope<Args extends unknown[], Result>(
  scope: RuntimeScope,
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => inRuntimeScope(scope, () => fn(...args));
}

/** Pi invokes registered callbacks outside the factory's async context. */
export function scopeExtensionAPI(pi: ExtensionAPI, scope: RuntimeScope): ExtensionAPI {
  return {
    ...pi,
    on: ((event: string, handler: (...args: unknown[]) => unknown) =>
      Reflect.apply(pi.on, pi, [event, bindRuntimeScope(scope, handler)])) as ExtensionAPI["on"],
    registerTool: tool => pi.registerTool(Object.assign(tool, {
      execute: bindRuntimeScope(scope, tool.execute),
      ...(tool.renderCall && { renderCall: bindRuntimeScope(scope, tool.renderCall) }),
      ...(tool.renderResult && { renderResult: bindRuntimeScope(scope, tool.renderResult) }),
    })),
    registerCommand: (name, command) => pi.registerCommand(name, { ...command, handler: bindRuntimeScope(scope, command.handler) }),
    registerMessageRenderer: (name, renderer) => pi.registerMessageRenderer(name, bindRuntimeScope(scope, renderer)),
    registerEntryRenderer: (name, renderer) => pi.registerEntryRenderer(name, bindRuntimeScope(scope, renderer)),
    events: {
      ...pi.events,
      on: (event, handler) => pi.events.on(event, bindRuntimeScope(scope, handler)),
    },
  };
}
