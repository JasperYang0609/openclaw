import type { ProgressContinuationDraft } from "../../../channels/progress-continuation.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  assertSubagentRegistryWriteSourceCurrent,
} from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { latestSubagentRun } from "./subagent-run-generation.js";

type ProgressItem = Parameters<ProgressContinuationDraft["push"]>[0];

type Member = {
  childSessionKey: string;
  childAgentId?: string;
  /** Last observed current execution of this logical task. */
  row: SubagentRunRecord;
  stopEvents: () => void;
};

type LiveDraft = {
  draft: ProgressContinuationDraft;
  /** Announcing tasks, by logical task id, whose result the requester is still owed. */
  members: Map<string, Member>;
  stopChanges: () => void;
  stateContext: ReturnType<typeof captureOpenClawStateWorkerContext>;
  waitTimer?: ReturnType<typeof setTimeout>;
  retired: boolean;
};

// Process-local: the channel transport cannot outlive this Gateway, so a
// replacement never revives a card from stored state.
const liveByTask = new Map<string, LiveDraft>();
const liveByWake = new Map<string, LiveDraft>();
const WAIT_STATUS_REFRESH_MS = 90_000;

const taskId = (entry: SubagentRunRecord) => entry.taskRunId ?? entry.runId;

/**
 * An implicit continuation persists yield intent before its status is delivered.
 * Visual custody can follow that intent without releasing the requester claim;
 * the outbox still transfers final-delivery debt only after confirmed delivery.
 */
function owesCompletion(entry: SubagentRunRecord | undefined): entry is SubagentRunRecord {
  if (
    !entry ||
    entry.suppressCompletionDelivery === true ||
    entry.killReconciliation?.suppressTaskDelivery === true
  ) {
    return false;
  }
  return (
    entry.requesterSettleWake !== undefined ||
    (entry.requesterTurnRunId !== undefined &&
      entry.requesterTurnYielded === true &&
      entry.expectsCompletionMessage === true &&
      entry.completion?.required === true &&
      (entry.delivery?.status === "pending" || entry.delivery?.status === "failed") &&
      entry.delivery.disposition !== "permanent_failure")
  );
}

/** Steering and resumed yields replace a task's execution under the same task id. */
function currentRow(
  id: string,
  childSessionKey: string,
  childAgentId?: string,
): SubagentRunRecord | undefined {
  return latestSubagentRun(
    getSubagentRunsForChildSession(childSessionKey, childAgentId),
    (entry) => taskId(entry) === id,
  );
}

/** Only prepared operation names and outcomes cross a private child's audience boundary. */
function projectActivity(event: AgentEventPayload, itemId: string): ProgressItem | undefined {
  const { data } = event;
  if (
    event.stream !== "item" ||
    data.kind !== "tool" ||
    data.hideFromChannelProgress === true ||
    data.suppressChannelProgress === true ||
    typeof data.name !== "string" ||
    !/^[\w.:-]{1,120}$/.test(data.name) ||
    typeof data.status !== "string" ||
    !["running", "completed", "failed", "blocked", "skipped"].includes(data.status)
  ) {
    return undefined;
  }
  const status = data.status;
  return {
    itemId,
    kind: "tool",
    name: data.name,
    phase: status === "running" ? "update" : "end",
    status,
  };
}

function projectChild(entry: SubagentRunRecord): ProgressItem {
  const paused = entry.pauseReason === "sessions_yield";
  const ended = entry.execution.status === "terminal" && !paused;
  const outcome = ended ? entry.execution.outcome?.status : undefined;
  return {
    itemId: taskId(entry),
    kind: "subagent",
    title: (entry.label ?? entry.taskName ?? "Delegated work").slice(0, 120),
    phase: ended ? "end" : "update",
    status:
      outcome === "ok"
        ? "completed"
        : outcome === "error" || outcome === "timeout"
          ? "failed"
          : ended || paused
            ? undefined
            : "running",
    summary: paused ? "waiting" : ended && !outcome ? "outcome unknown" : undefined,
  };
}

function follow(live: LiveDraft, runId: string, itemId: string): () => void {
  return onAgentEventForRun(runId, (event) => {
    const item = projectActivity(event, itemId);
    if (item) {
      live.draft.push(item);
    }
  });
}

function track(live: LiveDraft, entries: readonly SubagentRunRecord[]): void {
  for (const entry of entries) {
    const id = taskId(entry);
    if (live.members.has(id) || !owesCompletion(entry)) {
      continue;
    }
    live.members.set(id, {
      childSessionKey: entry.childSessionKey,
      childAgentId: entry.childAgentId,
      row: entry,
      stopEvents: follow(live, entry.runId, `${id}:tool`),
    });
    liveByTask.set(id, live);
    live.draft.push(projectChild(entry));
  }
}

function drop(live: LiveDraft, id: string): void {
  live.members.get(id)?.stopEvents();
  live.members.delete(id);
  liveByTask.delete(id);
}

function retire(live: LiveDraft): void {
  if (live.retired) {
    return;
  }
  live.retired = true;
  clearTimeout(live.waitTimer);
  live.waitTimer = undefined;
  live.stopChanges();
  for (const id of live.members.keys()) {
    drop(live, id);
  }
  live.draft.retire();
}

/**
 * Settlement, retries, stop, reset and replacement all commit through registry
 * publications, so the draft follows committed task state rather than callers.
 */
function reconcile(live: LiveDraft): void {
  for (const [id, member] of live.members) {
    const row = currentRow(id, member.childSessionKey, member.childAgentId);
    if (row === member.row) {
      continue;
    }
    if (!owesCompletion(row)) {
      drop(live, id);
      continue;
    }
    if (row.runId !== member.row.runId) {
      member.stopEvents();
      member.stopEvents = follow(live, row.runId, `${id}:tool`);
    }
    member.row = row;
    live.draft.push(projectChild(row));
  }
  if (live.members.size === 0) {
    retire(live);
  }
}

/** Refresh recorded waiting state, not a claim that an executor is making progress. */
function scheduleWaitingStatus(live: LiveDraft): void {
  if (live.retired || live.waitTimer || live.members.size === 0) {
    return;
  }
  live.waitTimer = setTimeout(() => {
    live.waitTimer = undefined;
    if (live.retired) {
      return;
    }
    try {
      assertSubagentRegistryWriteSourceCurrent(live.stateContext);
      const runIds = [...live.members].flatMap(([id, member]) => [
        member.row.runId,
        currentRow(id, member.childSessionKey, member.childAgentId)?.runId ?? member.row.runId,
      ]);
      assertSubagentRegistryWriteOutcomeKnown(runIds, live.stateContext.admission);
    } catch {
      // Do not turn stale or uncertain registry state into a perpetual positive heartbeat.
      live.draft.push({
        itemId: "requester:wait",
        kind: "subagent",
        phase: "update",
        title: "Waiting status unavailable; inspect task state",
        summary: "waiting",
      });
      return;
    }
    reconcile(live);
    if (live.retired) {
      return;
    }
    const ended = [...live.members.values()].every(
      ({ row }) => row.execution.status === "terminal" && row.pauseReason !== "sessions_yield",
    );
    const state = ended
      ? "Delegated tasks ended; requester response pending"
      : "Delegated results pending";
    live.draft.push({
      itemId: "requester:wait",
      kind: "subagent",
      phase: "update",
      title: state + " · recorded status checked at " + new Date().toISOString(),
      summary: "waiting",
    });
    scheduleWaitingStatus(live);
  }, WAIT_STATUS_REFRESH_MS);
  live.waitTimer.unref?.();
}

/**
 * Keep the yielding turn's confirmed draft for its announcing children. The
 * requester settle wake remains the only final-delivery owner; the draft is
 * retired once no tracked task is owed to the requester anymore.
 */
export function adoptSubagentProgressDraft(
  spawns: readonly AcceptedSessionSpawn[],
  draft: ProgressContinuationDraft,
): boolean {
  const entries = spawns
    .filter((spawn) => spawn.expectsCompletionMessage === true)
    .map((spawn) => currentRow(spawn.runId, spawn.childSessionKey));
  if (
    entries.length === 0 ||
    !entries.every(owesCompletion) ||
    entries.some(
      (entry) =>
        liveByTask.has(taskId(entry)) ||
        // A resumed requester keeps its inherited draft across delivery-gated re-yield.
        (entry.requesterTurnRunId !== undefined &&
          liveByWake.get(entry.requesterTurnRunId)?.retired === false) ||
        entry.killIntent ||
        entry.killReconciliation ||
        // A wake that already started cannot report a re-yield to this draft.
        entry.requesterSettleWake?.status === "dispatching",
    )
  ) {
    return false;
  }
  const live: LiveDraft = {
    draft,
    members: new Map(),
    stopChanges: () => undefined,
    stateContext: captureOpenClawStateWorkerContext(),
    retired: false,
  };
  live.stopChanges = subscribeSubagentRunChanges("projection", () => reconcile(live));
  track(live, entries);
  scheduleWaitingStatus(live);
  return true;
}

/** Show the resumed requester's work on the same draft while its settle wake runs. */
export async function withSubagentProgressDraft<T>(
  batch: readonly SubagentRunRecord[],
  wakeRunId: string,
  run: () => Promise<T>,
): Promise<T> {
  const live = batch.map((entry) => liveByTask.get(taskId(entry))).find(Boolean);
  if (!live) {
    return await run();
  }
  liveByWake.set(wakeRunId, live);
  const stopEvents = follow(live, wakeRunId, "requester:tool");
  try {
    return await run();
  } finally {
    stopEvents();
    liveByWake.delete(wakeRunId);
  }
}

/** A resumed requester that yields again hands its committed cohort to the same card. */
export function trackSubagentProgressYield(
  requesterTurnRunId: string,
  entries: readonly SubagentRunRecord[],
): void {
  const live = liveByWake.get(requesterTurnRunId);
  if (live && live.members.size > 0) {
    track(live, entries);
  }
}
