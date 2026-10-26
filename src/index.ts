import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-azure-compat:state:v1";
const RESOURCE_ERROR = /The\s+requested\s+item\s+was\s+created\s+under\s+a\s+different\s+Azure\s+OpenAI\s+resource\b/i;
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses"]);
type SelectedModel = NonNullable<ExtensionContext["model"]>;
type WirePayload = Record<string, unknown> & { model: string; input: unknown[] };
type StateChange =
  | { kind: "rejected"; scope: string; ids: string[] }
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

function readPolicy(ctx: ExtensionContext, scope?: string): { enabled: boolean; ids: Set<string> } {
  let enabled = true;
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (data.kind === "mode" && typeof data.enabled === "boolean") enabled = data.enabled;
    if (scope === undefined || data.scope !== scope) continue;
    if (data.kind === "reset") ids.clear();
    if (data.kind === "rejected" && Array.isArray(data.ids)) {
      for (const id of data.ids) if (typeof id === "string") ids.add(id);
    }
  }
  return { enabled, ids };
}

function eligible(payload: unknown, model: SelectedModel): payload is WirePayload {
  return RESPONSES_APIS.has(model.api)
    && isRecord(payload) && payload.model === model.id && Array.isArray(payload.input)
    && payload.store !== true
    && (payload.previous_response_id === undefined || payload.previous_response_id === null)
    && !payload.input.some((item) => isRecord(item) && item.type === "item_reference");
}

/** Recover only an unambiguous, empty Azure resource-identity rejection. */
export default function azureCompat(pi: ExtensionAPI): void {
  let snapshot: Snapshot | undefined;
  let inTurn = false;
  let requestsInTurn = 0;
  let recoveriesInOperation = 0;
  const stats = { requests: 0, cleanedRequests: 0, cleanedIds: 0, recoveries: 0 };

  function clearOperation(): void {
    snapshot = undefined;
    inTurn = false;
    requestsInTurn = 0;
    recoveriesInOperation = 0;
  }
  pi.on("session_start", () => {
    clearOperation();
    Object.assign(stats, { requests: 0, cleanedRequests: 0, cleanedIds: 0, recoveries: 0 });
  });
  pi.on("session_shutdown", clearOperation);
  pi.on("agent_settled", clearOperation);
  pi.on("turn_start", () => {
    snapshot = undefined;
    inTurn = true;
    requestsInTurn = 0;
  });
  pi.on("turn_end", () => { inTurn = false; });

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
    const ids = [...new Set(result.input.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []))];
    snapshot = { scope, ids, provider: model.provider, api: model.api, model: model.id };
    return result;
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome !== "error" || event.continue || !snapshot || requestsInTurn !== 1
      || recoveriesInOperation >= 1 || snapshot.ids.length === 0 || ctx.signal?.aborted) return;
    if (!readPolicy(ctx, snapshot.scope).enabled || !ctx.model || scopeOf(ctx.model) !== snapshot.scope) return;
    const contribution = event.context.contextEntries.findLast((entry) => entry.messages.some((message) => message.role === "assistant"));
    const message = contribution?.messages.findLast((value) => value.role === "assistant");
    // HTTP JSON strings may contain literal escaped newlines; SSE may contain real ones.
    const error = String(message?.errorMessage ?? "").replace(/\\[nrt]/g, " ");
    if (!message || message.stopReason !== "error" || !RESOURCE_ERROR.test(error)) return;
    if (message.provider !== snapshot.provider || message.api !== snapshot.api || message.model !== snapshot.model) return;
    if (message.content.length !== 0 || contribution?.sourceEntry.type !== "message") return;

    const rejected: StateChange = { kind: "rejected", scope: snapshot.scope, ids: snapshot.ids };
    recoveriesInOperation++;
    stats.recoveries++;
    snapshot = undefined;
    ctx.ui.notify(`Azure resource identity mismatch: retrying without ${rejected.ids.length} historical item IDs; encrypted reasoning is preserved.`, "warning");
    return {
      entries: [
        { type: "custom", customType: STATE_TYPE, data: rejected },
        { type: "context_edit", targetId: contribution.sourceEntry.id, replacement: null },
      ],
      continue: true,
    };
  });

  pi.registerCommand("azure-compat", {
    description: "Azure resource identity recovery: status | on | off | reset",
    getArgumentCompletions: (prefix) => ["status", "on", "off", "reset"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      const scope = ctx.model ? scopeOf(ctx.model) : undefined;
      if (action === "on" || action === "off") {
        const change: StateChange = { kind: "mode", enabled: action === "on" };
        pi.appendEntry(STATE_TYPE, change);
        snapshot = undefined;
      } else if (action === "reset") {
        if (!scope) { ctx.ui.notify("Select a model before resetting Azure compatibility state.", "warning"); return; }
        const change: StateChange = { kind: "reset", scope };
        pi.appendEntry(STATE_TYPE, change);
        snapshot = undefined;
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /azure-compat [status|on|off|reset]", "warning");
        return;
      }
      const policy = readPolicy(ctx, scope);
      ctx.ui.notify(`pi-azure-compat: ${policy.enabled ? "on" : "off"}; ${policy.ids.size} rejected IDs for the selected model. Runtime: ${stats.requests} eligible requests, ${stats.cleanedRequests} cleaned, ${stats.cleanedIds} IDs removed, ${stats.recoveries} recoveries.`, "info");
    },
  });
}
