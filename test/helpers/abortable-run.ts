import type { RunResult, resumeAgent, runAgent } from "../../src/agent-runner.js";

/** A live run must settle when its owner cancels it, just like an SDK prompt. */
export const abortableRun: typeof runAgent = (_ctx, _type, _prompt, options) =>
  new Promise<RunResult>(resolve => {
    const finish = () => resolve({
      responseText: "", aborted: true, steered: false,
      session: { dispose() {} } as RunResult["session"],
    });
    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener("abort", finish, { once: true });
  });

export const abortableResume: typeof resumeAgent = (_session, _prompt, options) =>
  new Promise(resolve => {
    const finish = () => resolve({ text: "" });
    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener("abort", finish, { once: true });
  });
