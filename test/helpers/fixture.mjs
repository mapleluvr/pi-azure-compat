import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.ts";

export const RESOURCE_ERROR = "The requested item was created under a\n different Azure OpenAI resource.";
export const ENC = "opaque-encrypted-history-keep-byte-for-byte";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function respond(res, behavior) {
  if (["resource", "enc", "tool-output", "ordinary-id-error"].includes(behavior)) {
    const message = { resource: RESOURCE_ERROR, enc: "The encrypted content could not be verified", "tool-output": "A tool call is missing its matching output", "ordinary-id-error": "Item with id rs_unknown was not found" }[behavior];
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "invalid_request_error", code: null } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (behavior === "partial-resource") {
    emit({ type: "response.created", response: { id: "resp_partial", status: "in_progress" } });
    emit({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", content: [] } });
    emit({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "already-visible" });
    emit({ type: "response.failed", response: { id: "resp_partial", status: "failed", error: { message: RESOURCE_ERROR, code: "invalid_request_error" } } });
  } else if (behavior === "sse-resource") {
    emit({ type: "response.failed", response: { id: "resp_failed", status: "failed", error: { message: RESOURCE_ERROR, code: "invalid_request_error" } } });
  } else {
    const item = { type: "message", id: "msg_fresh", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] };
    emit({ type: "response.created", response: { id: "resp_ok", status: "in_progress" } });
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "fixture-ok" });
    emit({ type: "response.output_item.done", output_index: 0, item });
    emit({ type: "response.completed", response: { id: "resp_ok", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  }
  res.end();
}

export async function runFixture(behaviors, { prompts = 1, mutatePayload, afterTurn, abortAtEnd = false, restartAfterFirst = false, rollbackBeforeRepair = false, diskResume = false, beforePrompt, afterPrompt, precedingExtension, trailingExtension } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-azure-compat-"));
  const requests = [], events = [], extensionErrors = [];
  let session, manager;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (requests.length > 8) { respond(res, "enc"); return; }
    respond(res, behaviors[requests.length - 1] ?? "ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const modelConfig = { id: "gpt-replay-fixture", name: "Replay fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
    modelRuntime.registerProvider("ReplayFixture", { api: "openai-responses", apiKey: "loopback-only", baseUrl, models: [modelConfig] });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Loopback compatibility test.", extensionFactories: [
      (pi) => {
        if (mutatePayload) pi.on("before_provider_request", ({ payload }) => { mutatePayload(payload); });
        if (afterTurn) pi.on("turn_end", afterTurn);
        precedingExtension?.(pi);
      },
      extension,
      (pi) => {
        if (abortAtEnd) pi.on("agent_end", (_event, ctx) => { if (requests.length === 1) ctx.abort(); });
        trailingExtension?.(pi);
      },
    ] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    manager = diskResume ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
    manager.appendMessage({ role: "assistant", provider: "ReplayFixture", api: "openai-responses", model: "gpt-replay-fixture", stopReason: "toolUse", timestamp: 2, usage: structuredClone(usage), content: [
      { type: "thinking", thinking: "summary", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_history", summary: [], encrypted_content: ENC }) },
      { type: "text", text: "old answer", textSignature: JSON.stringify({ v: 1, id: "msg_history" }) },
      { type: "toolCall", id: "call_history|fc_history", name: "fixture_tool", arguments: { value: 7 } },
    ] });
    manager.appendMessage({ role: "toolResult", toolCallId: "call_history|fc_history", toolName: "fixture_tool", content: [{ type: "text", text: "tool-result" }], isError: false, timestamp: 3 });
    async function createSession() {
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: modelRuntime.getModel("ReplayFixture", "gpt-replay-fixture"), thinkingLevel: "low", settingsManager, resourceLoader, sessionManager: manager, tools: [] }));
      session.subscribe((event) => events.push(event.type));
      await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    }
    await createSession();
    for (let i = 0; i < prompts; i++) {
      if (i === 1 && restartAfterFirst) {
        session.dispose();
        if (rollbackBeforeRepair) {
          const failed = manager.getBranch().find((entry) => entry.type === "message" && entry.message.stopReason === "error");
          manager.branch(failed.id);
        }
        if (diskResume) manager = SessionManager.open(manager.getSessionFile(), join(dir, "sessions"));
        await resourceLoader.reload();
        await createSession();
      }
      const fixture = { session, manager, modelRuntime, modelConfig, baseUrl, requests, events, dir };
      await beforePrompt?.(fixture, i);
      await session.prompt(`question-${i}`);
      await afterPrompt?.(fixture, i);
    }
    return { requests, events, extensionErrors, entries: manager.getBranch(), lastText: session.getLastAssistantText(), messages: session.messages };
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
