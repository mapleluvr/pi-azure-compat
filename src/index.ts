import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-azure-compat:state:v1";
const STRICT_RESOURCE_ERROR = /The\s+requested\s+item\s+was\s+created\s+under\s+a\s+different\s+Azure\s+OpenAI\s+resource\b/i;
const ITEM_IDENTITY_CLAUSE = /The\s+requested\s+item\s+was\s+created\s+under\s+a\s+different\b[^.]{0,120}?\bresource\b(?!\s+(?:group|quota|limit|provider)\b)/i;
const SAME_RESOURCE_HINT = /same\s+resource\s+that\s+created\s+the\s+item\b/i;
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses"]);
type ResourceErrorMatch = "strict" | "redacted" | "weak" | "none";
type SkipReason =
  | "continued"
  | "no-snapshot"
  | "multi-request"
  | "aborted"
  | "disabled"
  | "scope"
  | "message"
  | "provider"
  | "unmatched"
  | "budget"
  | "no-ids"
  | "prepared";
type SelectedModel = NonNullable<ExtensionContext["model"]>;
type WirePayload = Record<string, unknown> & { model: string; input: unknown[] };
type StateChange =
  | { kind: "rejected"; scope: string; ids: string[] }
  | { kind: "clean-next"; scope: string }
  | { kind: "reset"; scope: string }
  | { kind: "mode"; enabled: boolean };
interface Snapshot {
  scope: string;
  ids: string[];
  provider: string;
  api: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeOf(model: SelectedModel): string {
  // Persist a digest, not an endpoint URL that could contain credentials.
  return createHash("sha256").update(JSON.stringify([model.provider, model.api, model.baseUrl, model.id])).digest("hex");
}

function readPolicy(ctx: ExtensionContext, scope?: string): { enabled: boolean; ids: Set<string>; cleanNext: boolean } {
  let enabled = true;
  let cleanNext = false;
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (data.kind === "mode" && typeof data.enabled === "boolean") enabled = data.enabled;
    if (scope === undefined || data.scope !== scope) continue;
    if (data.kind === "reset") { ids.clear(); cleanNext = false; }
    if (data.kind === "clean-next") cleanNext = true;
    if (data.kind === "rejected" && Array.isArray(data.ids)) {
      cleanNext = false;
      for (const id of data.ids) if (typeof id === "string") ids.add(id);
    }
  }
  return { enabled, ids, cleanNext };
}

function eligible(payload: unknown, model: SelectedModel): payload is WirePayload {
  return RESPONSES_APIS.has(model.api)
    && isRecord(payload) && payload.model === model.id && Array.isArray(payload.input)
    && payload.store !== true
    && (payload.previous_response_id === undefined || payload.previous_response_id === null)
    && !payload.input.some((item) => isRecord(item) && item.type === "item_reference");
}

function itemIds(input: unknown[]): string[] {
  return [...new Set(input.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []))];
}

function normalizeErrorText(value: unknown): string {
  // HTTP JSON strings may contain literal escaped newlines; SSE may contain real ones.
  return String(value ?? "")
    .replace(/\\[nrt]/g, " ")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyResourceError(text: string): ResourceErrorMatch {
  if (STRICT_RESOURCE_ERROR.test(text)) return "strict";
  if (!ITEM_IDENTITY_CLAUSE.test(text)) return "none";
  return SAME_RESOURCE_HINT.test(text) ? "redacted" : "weak";
}

/** Recover narrow Azure identity errors and support explicit history-ID cleanup. */
export default function azureCompat(pi: ExtensionAPI): void {
  let snapshot: Snapshot | undefined;
  let pendingContinuationScope: string | undefined;
  let inTurn = false;
  let requestsInTurn = 0;
  let recoveriesInOperation = 0;
  let weakHinted = false;
  let lastMatch: ResourceErrorMatch = "none";
  let lastSkip: SkipReason | undefined;
  const stats = { requests: 0, cleanedRequests: 0, cleanedIds: 0, recoveries: 0 };

  function clearOperation(): void {
    snapshot = undefined;
    pendingContinuationScope = undefined;
    inTurn = false;
    requestsInTurn = 0;
    recoveriesInOperation = 0;
    weakHinted = false;
  }
  pi.on("session_start", () => {
    clearOperation();
    lastMatch = "none";
    lastSkip = undefined;
    Object.assign(stats, { requests: 0, cleanedRequests: 0, cleanedIds: 0, recoveries: 0 });
  });
  pi.on("session_shutdown", clearOperation);
  pi.on("agent_settled", clearOperation);
  pi.on("turn_start", () => {
    snapshot = undefined;
    // Any next turn, including an agent_end fallback, consumes the prepared repair.
    pendingContinuationScope = undefined;
    inTurn = true;
    requestsInTurn = 0;
  });

  pi.on("before_provider_request", ({ payload }, ctx) => {
    // Idle/background calls cannot replace a captured main-turn request.
    if (!inTurn) return;
    snapshot = undefined;
    if (++requestsInTurn !== 1) return;
    const model = ctx.model;
    if (!model || !eligible(payload, model)) return;
    stats.requests++;
    const scope = scopeOf(model);
    const policy = readPolicy(ctx, scope);
    if (!policy.enabled) return;
    if (policy.cleanNext) {
      // Capture the serialized history after context transforms, including MC.
      // An empty set still consumes the explicit one-shot cleanup.
      const ids = itemIds(payload.input);
      const change: StateChange = { kind: "rejected", scope, ids };
      pi.appendEntry(STATE_TYPE, change);
      for (const id of ids) policy.ids.add(id);
    }

    let cleaned = 0;
    const input = payload.input.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || !policy.ids.has(item.id)) return item;
      const copy = { ...item };
      delete copy.id;
      cleaned++;
      return copy;
    });
    // Only changed wire items are cloned. History, ciphertext and call_id are untouched.
    const result = cleaned > 0 ? { ...payload, input } : payload;
    if (cleaned > 0) {
      stats.cleanedRequests++;
      stats.cleanedIds += cleaned;
    }
    const ids = itemIds(result.input);
    snapshot = { scope, ids, provider: model.provider, api: model.api, model: model.id };
    return result;
  });

  pi.on("turn_end", (event, ctx) => {
    inTurn = false;
    if (event.outcome !== "error") return;
    lastMatch = "none";
    lastSkip = "message";
    if (event.continue) { lastSkip = "continued"; return; }
    if (!snapshot) { lastSkip = "no-snapshot"; return; }
    if (requestsInTurn !== 1) { lastSkip = "multi-request"; return; }
    if (ctx.signal?.aborted) { lastSkip = "aborted"; return; }
    const policy = readPolicy(ctx, snapshot.scope);
    if (!policy.enabled) { lastSkip = "disabled"; return; }
    if (!ctx.model || scopeOf(ctx.model) !== snapshot.scope) { lastSkip = "scope"; return; }
    const contribution = event.context.contextEntries.find((entry) => entry.sourceEntry.id === event.messageEntryId);
    const message = contribution?.messages.findLast((value) => value.role === "assistant");
    if (!message) { lastSkip = "message"; return; }
    lastMatch = classifyResourceError(normalizeErrorText(message.errorMessage));
    if (message.stopReason !== "error" || message.content.length !== 0
      || contribution?.sourceEntry.type !== "message") { lastSkip = "message"; return; }
    if (message.provider !== snapshot.provider || message.api !== snapshot.api || message.model !== snapshot.model) {
      lastSkip = "provider";
      return;
    }
    if (snapshot.ids.length === 0) { lastSkip = "no-ids"; return; }
    if (lastMatch === "weak") {
      lastSkip = "unmatched";
      if (!weakHinted) {
        weakHinted = true;
        ctx.ui.notify("Unrecognized item/resource identity error; if this is the Azure cross-resource error, run /azure-compat clean and resubmit. No request was changed.", "warning");
      }
      return;
    }
    if (lastMatch === "none") { lastSkip = "unmatched"; return; }
    if (recoveriesInOperation >= 1) { lastSkip = "budget"; return; }

    const rejected: StateChange = { kind: "rejected", scope: snapshot.scope, ids: snapshot.ids };
    recoveriesInOperation++;
    stats.recoveries++;
    pendingContinuationScope = snapshot.scope;
    snapshot = undefined;
    lastSkip = "prepared";
    ctx.ui.notify(`Azure resource identity mismatch (${lastMatch}): retrying without ${rejected.ids.length} historical item IDs; encrypted reasoning is preserved.`, "warning");
    // Commit before agent_end can queue a generic fallback. Error-branch turn_end
    // continuation is ignored by Pi 1.4.0, so settlement supplies it only if needed.
    return {
      entries: [
        { type: "custom", customType: STATE_TYPE, data: rejected },
        { type: "context_edit", targetId: contribution.sourceEntry.id, replacement: null },
      ],
      continue: true,
    };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (!pendingContinuationScope || event.outcome !== "error" || event.continue
      || ctx.signal?.aborted || !event.context.canContinue) return;
    if (!readPolicy(ctx, pendingContinuationScope).enabled || !ctx.model
      || scopeOf(ctx.model) !== pendingContinuationScope) return;
    pendingContinuationScope = undefined;
    return { continue: true };
  });

  pi.registerCommand("azure-compat", {
    description: "Responses history: status | clean | on | off | reset",
    getArgumentCompletions: (prefix) => ["status", "clean", "on", "off", "reset"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      const scope = ctx.model ? scopeOf(ctx.model) : undefined;
      if (action === "on" || action === "off") {
        const change: StateChange = { kind: "mode", enabled: action === "on" };
        pi.appendEntry(STATE_TYPE, change);
        snapshot = undefined;
        pendingContinuationScope = undefined;
      } else if (action === "reset") {
        if (!scope) { ctx.ui.notify("Select a model before resetting Azure compatibility state.", "warning"); return; }
        const change: StateChange = { kind: "reset", scope };
        pi.appendEntry(STATE_TYPE, change);
        snapshot = undefined;
        pendingContinuationScope = undefined;
      } else if (action === "clean") {
        if (!ctx.model || !RESPONSES_APIS.has(ctx.model.api) || !scope) {
          ctx.ui.notify("Select a Responses model before cleaning historical item IDs.", "warning");
          return;
        }
        if (!readPolicy(ctx, scope).enabled) {
          const mode: StateChange = { kind: "mode", enabled: true };
          pi.appendEntry(STATE_TYPE, mode);
        }
        const change: StateChange = { kind: "clean-next", scope };
        pi.appendEntry(STATE_TYPE, change);
        snapshot = undefined;
        pendingContinuationScope = undefined;
        ctx.ui.notify("Historical item-ID cleanup is ready; compatibility is on. Re-submit your prompt: the next eligible request will remove history item IDs while preserving encrypted reasoning and call_id. Later fresh IDs are kept.", "info");
        return;
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /azure-compat [status|clean|on|off|reset]", "warning");
        return;
      }
      const policy = readPolicy(ctx, scope);
      const lastError = lastMatch === "none" && !lastSkip ? "none" : `${lastMatch} (${lastSkip ?? "unclassified"})`;
      ctx.ui.notify(`pi-azure-compat: ${policy.enabled ? "on" : "off"}; ${policy.ids.size} suppressed item IDs for the selected model; manual cleanup ${policy.cleanNext ? "pending" : "idle"}. Runtime: ${stats.requests} eligible requests, ${stats.cleanedRequests} cleaned, ${stats.cleanedIds} IDs removed, ${stats.recoveries} recoveries. Last error: ${lastError}.`, "info");
    },
  });
}
