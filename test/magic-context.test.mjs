// Isolated integration with the actually installed Magic Context package, not a mock.
// No production config/session/database is loaded. All provider traffic is loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-magic-replay-"));
const initialCwd = process.cwd();
process.chdir(root);
for (const [key, value] of Object.entries({
  HOME: root, USERPROFILE: root,
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"), MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "data"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
})) process.env[key] = value;
await mkdir(join(root, "config", "cortexkit"), { recursive: true });
await writeFile(join(root, "config", "cortexkit", "magic-context.jsonc"), JSON.stringify({
  enabled: true, historian: { disable: true }, dreamer: { disable: true },
  memory: { enabled: false, auto_search: { enabled: false } },
  smart_notes: { enabled: false }, todowrite: { enabled: false },
  keep_reasoning_tokens: 1000000, protected_tokens: 0, protected_tags: 0,
}));
const sdk = await import("@earendil-works/pi-coding-agent");
const magicEntry = import.meta.resolve("@cortexkit/pi-magic-context");
const { default: magic } = await import(magicEntry);
const { version } = JSON.parse(await readFile(new URL("../package.json", magicEntry), "utf8"));
const { default: repair } = await import("../src/index.ts");
const originalFetch = globalThis.fetch;
const unexpectedNetwork = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "127.0.0.1") { unexpectedNetwork.push(url.origin); throw new Error("Research permits loopback only"); }
  return originalFetch(input, init);
};
const ENC = "isolated-magic-context-ciphertext";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(order) {
  const dir = join(root, order);
  await mkdir(dir, { recursive: true });
  const requests = [], errors = [], tools = new Map(), commands = new Map(), contextPasses = [], shutDown = [];
  let session, lastContext;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (requests.length === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "The requested item was created under a\n different Azure OpenAI resource." } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const item = { type: "message", id: `msg_fresh_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "joint-fixture-ok", annotations: [] }] };
    emit({ type: "response.created", response: { id: "resp_joint", status: "in_progress" } });
    emit({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "joint-fixture-ok" });
    emit({ type: "response.output_item.done", output_index: 0, item });
    emit({ type: "response.completed", response: { id: "resp_joint", status: "completed", output: [item], usage: { input_tokens: 40, output_tokens: 3, total_tokens: 43, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
    runtime.registerProvider("MagicReplayFixture", { api: "openai-responses", apiKey: "loopback", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: "gpt-joint-fixture", name: "Joint fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 64 }] });
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: { enabled: false } });
    const observedMagic = (pi) => magic(new Proxy(pi, { get(target, property) {
      if (property === "registerTool") return (definition) => { tools.set(definition.name, definition); return target.registerTool(definition); };
      if (property === "registerCommand") return (name, definition) => { commands.set(name, definition); return target.registerCommand(name, definition); };
      if (property === "on") return (event, handler) => {
        if (event === "session_shutdown") shutDown.push(handler);
        return target.on(event, handler);
      };
      return Reflect.get(target, property);
    } }));
    const monitor = (pi) => {
      pi.on("context", (event, ctx) => { lastContext = ctx; contextPasses.push(event.messages.length); });
    };
    const factories = order === "magic-first" ? [observedMagic, repair, monitor] : [repair, observedMagic, monitor];
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: join(root, "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Isolated compatibility test.", extensionFactories: factories });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = sdk.SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "historical question", timestamp: Date.now() - 3000 });
    manager.appendMessage({ role: "assistant", provider: "MagicReplayFixture", api: "openai-responses", model: "gpt-joint-fixture", stopReason: "toolUse", timestamp: Date.now() - 2000, usage: structuredClone(usage), content: [
      { type: "thinking", thinking: "history reasoning", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_joint", encrypted_content: ENC, summary: [] }) },
      { type: "text", text: "history answer", textSignature: JSON.stringify({ v: 1, id: "msg_joint" }) },
      { type: "toolCall", id: "call_joint|fc_joint", name: "fixture_tool", arguments: {} },
    ] });
    manager.appendMessage({ role: "toolResult", toolCallId: "call_joint|fc_joint", toolName: "fixture_tool", content: [{ type: "text", text: "reducible-history-output" }], isError: false, timestamp: Date.now() - 1000 });
    ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: join(root, "agent"), modelRuntime: runtime, model: runtime.getModel("MagicReplayFixture", "gpt-joint-fixture"), settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [] }));
    await session.bindExtensions({ onError: (e) => errors.push(e) });
    await session.prompt("Continue the historical question.");
    assert.equal(requests.length, 2, JSON.stringify({ errors, contextPasses, unexpectedNetwork, failures: session.messages.filter((m) => m.stopReason === "error" || m.stopReason === "aborted").map((m) => ({ stopReason: m.stopReason, errorMessage: m.errorMessage })) }));
    assert.equal(requests[0].input.find((x) => x.type === "reasoning")?.id, "rs_joint");
    assert.equal(requests[1].input.find((x) => x.type === "reasoning")?.encrypted_content, ENC);
    assert.equal(requests[1].input.some((x) => typeof x.id === "string"), false);
    assert.equal(requests[1].input.find((x) => x.type === "function_call")?.call_id, "call_joint");
    assert.equal(requests[1].input.find((x) => x.type === "function_call_output")?.call_id, "call_joint");
    assert.deepEqual(requests[1].input.filter((x) => x.role === "user"), requests[0].input.filter((x) => x.role === "user"));
    assert.equal(manager.getBranch().filter((e) => e.type === "context_edit").length, 1);
    assert.equal(manager.getBranch().filter((e) => e.type === "message" && e.message.stopReason === "error").length, 1);
    assert.ok(tools.has("ctx_reduce"), "real MC tools must be registered");
    const toolOutput = requests[1].input.find((x) => x.type === "function_call_output")?.output;
    assert.ok(String(toolOutput).includes(String.fromCharCode(167)), "real MC tagging must run");
    await session.prompt("Continue again.");
    assert.equal(requests.length, 3);
    assert.equal(requests[2].input.some((x) => x.id === "rs_joint" || x.id === "msg_joint" || x.id === "fc_joint"), false);
    assert.equal(requests[2].input.some((x) => x.id === "msg_fresh_2"), true);
    // Exercise the real reduction queue and a subsequent materializing transform,
    // after the failed entry has been omitted by context_edit.
    const marker = String.fromCharCode(167);
    const tag = new RegExp(`${marker}(\\d+)${marker}`).exec(String(toolOutput))?.[1];
    assert.ok(tag, "the tool result must have a concrete MC tag");
    const reduction = await tools.get("ctx_reduce").execute("research-reduce", { drop: tag }, undefined, undefined, lastContext);
    assert.notEqual(reduction.isError, true, JSON.stringify(reduction));
    await commands.get("ctx-flush").handler("", lastContext);
    await session.prompt("Continue after materializing the queued reduction.");
    assert.equal(requests.length, 4);
    assert.equal(JSON.stringify(requests[3].input).includes("reducible-history-output"), false, JSON.stringify(reduction));
    assert.equal(requests[3].input.some((x) => x.id === "rs_joint" || x.id === "msg_joint" || x.id === "fc_joint"), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedNetwork, []);
    return { version, order, requests: requests.length, contextPasses, extensionErrors: errors.length };
  } finally {
    if (lastContext) for (const handler of shutDown) await handler({ type: "session_shutdown" }, lastContext);
    session?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const order of ["magic-first", "repair-first"]) test(`installed Magic Context ${version} + repair (${order})`, { timeout: 60000 }, async () => {
  console.log(JSON.stringify(await fixture(order)));
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(initialCwd);
  // Native SQLite handles may remain open until exit on Windows. Keep the isolated
  // directory rather than forcing deletion of a live database.
  await rm(join(root, "config"), { recursive: true, force: true });
  console.log(`Isolated research directory: ${root}`);
});
