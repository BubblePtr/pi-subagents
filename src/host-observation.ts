import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_READY_EVENT = "subagents:host:ready";

/** Serializable metadata; usage belongs to this agent's own model calls only. */
export interface SubagentHostRecord {
  id: string;
  rootSessionId: string;
  parentAgentId?: string;
  workflowId?: string;
  sessionId?: string;
  toolCallId?: string;
  type: string;
  description: string;
  status: AgentRecord["status"] | "stopping";
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionFile?: string;
  cwd?: string;
  toolUses: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
  currentTool?: string;
}

/** The session event fires synchronously before each initial or resumed prompt. */
export type SubagentHostEvent =
  | { type: "record"; record: SubagentHostRecord }
  | { type: "released"; record: SubagentHostRecord }
  | { type: "session"; record: SubagentHostRecord; session: AgentSession };

/** In-process capability scoped to one root session. Never send it over IPC. */
export interface SubagentHostProvider {
  snapshot(): SubagentHostRecord[];
  subscribe(listener: (event: SubagentHostEvent) => void): () => void;
  /** Cancel one agent tree, or all work for this root, and await actual settlement. */
  stop(agentId?: string): Promise<void>;
  steer?(agentId: string, message: string): Promise<void>;
  /** Permanently close the root's work and retained child sessions. Idempotent. */
  close(): Promise<void>;
}

export interface SubagentHostReady {
  version: typeof HOST_PROTOCOL_VERSION;
  rootSessionId: string;
  provider: SubagentHostProvider;
}
