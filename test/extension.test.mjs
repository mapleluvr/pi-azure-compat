// Behavioral contracts exercised through the real Pi SDK and loopback transport.
import assert from "node:assert/strict";
import test from "node:test";
import { ENC, runFixture } from "./helpers/fixture.mjs";

// Break caught: identity recovery that drops ciphertext, call_id, or fails to retry.
test("cross-resource: retry once with IDs removed, ciphertext and call linkage intact", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok"]);
  assert.equal(r.requests.length, 2, JSON.stringify({ errors: r.messages.filter((m) => m.stopReason === "error").map((m) => m.errorMessage), extensionErrors: r.extensionErrors }));
  assert.equal(r.requests[0].input.find((x) => x.type === "reasoning").id, "rs_history");
  assert.equal(r.requests[1].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
  assert.equal(r.requests[1].input.filter((x) => typeof x.id === "string").length, 0);
  assert.equal(r.requests[1].input.find((x) => x.type === "function_call").call_id, "call_history");
  assert.equal(r.requests[1].input.find((x) => x.type === "function_call_output").call_id, "call_history");
  assert.equal(r.requests[0].prompt_cache_key, r.requests[1].prompt_cache_key);
  assert.equal(r.lastText, "fixture-ok");
  assert.deepEqual(r.extensionErrors, []);
  const rawHistory = r.entries.find((entry) => entry.type === "message" && entry.message.content?.some?.((block) => block.type === "thinking"));
  assert.equal(JSON.parse(rawHistory.message.content.find((block) => block.type === "thinking").thinkingSignature).id, "rs_history");
  assert.equal(rawHistory.message.content.find((block) => block.type === "toolCall").id, "call_history|fc_history");
});

// Break caught: invisible retry markers still entering model context.
test("retry adds no custom_message/user marker and preserves the failed raw entry", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok"]);
  assert.deepEqual(r.requests[1].input.filter((x) => x.role === "user").map((x) => x.content), r.requests[0].input.filter((x) => x.role === "user").map((x) => x.content));
  assert.equal(r.entries.filter((x) => x.type === "custom_message").length, 0);
  assert.equal(r.entries.filter((x) => x.type === "message" && x.message.stopReason === "error").length, 1);
});

// Break caught: a broad error regex silently sacrificing reasoning for unrelated errors.
for (const behavior of ["enc", "tool-output"]) test(`does not recover unrelated ${behavior} error`, { timeout: 20000 }, async () => {
  const r = await runFixture([behavior, "ok"]);
  assert.equal(r.requests.length, 1);
});

// Break caught: persistent global stripping touching newly issued, still-valid IDs.
test("later request cleans the rejected snapshot but retains fresh response IDs", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok", "ok"], { prompts: 2 });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].input.some((x) => x.id === "rs_history" || x.id === "msg_history" || x.id === "fc_history"), false);
  assert.equal(r.requests[2].input.some((x) => x.id === "msg_fresh"), true);
  assert.equal(r.requests[2].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
});

test("reloading the extension restores rejected IDs from branch-local state", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok", "ok"], { prompts: 2, restartAfterFirst: true });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].input.some((item) => item.id === "rs_history"), false);
  assert.equal(r.requests[2].input.some((item) => item.id === "msg_fresh"), true);
});

test("a branch before the repair does not inherit the rejected-ID state", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok", "ok"], { prompts: 2, restartAfterFirst: true, rollbackBeforeRepair: true });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].input.some((item) => item.id === "rs_history"), true);
});

// Break caught: HTTP 200 being treated as success despite response.failed.
test("SSE response.failed is eligible for the same narrow recovery", { timeout: 20000 }, async () => {
  const r = await runFixture(["sse-resource", "ok"]);
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
  assert.equal(r.lastText, "fixture-ok");
});

// Break caught: repeating the same unrecoverable repair forever.
test("a second resource error with no removable IDs stops", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "resource", "ok"]);
  assert.equal(r.requests.length, 2);
});

// Break caught: changing reference semantics or retrying when cleaning is ineligible.
for (const [name, mutatePayload] of [
  ["store:true", (p) => { p.store = true; }],
  ["item_reference", (p) => { p.input.push({ type: "item_reference", id: "msg_reference" }); }],
  ["previous_response_id", (p) => { p.previous_response_id = "resp_reference"; }],
]) test(`does not auto-recover ${name}`, { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok"], { mutatePayload });
  assert.equal(r.requests.length, 1);
});

test("partial streamed output is not automatically replayed", { timeout: 20000 }, async () => {
  const r = await runFixture(["partial-resource", "ok"]);
  assert.equal(r.requests.length, 1);
});

test("abort after failure prevents recovery", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok"], { abortAtEnd: true });
  assert.equal(r.requests.length, 1);
});

test("no removable IDs means no recovery request", { timeout: 20000 }, async () => {
  const r = await runFixture(["resource", "ok"], { mutatePayload: (p) => { for (const item of p.input) delete item.id; } });
  assert.equal(r.requests.length, 1);
});

// Upstream characterization: finishTurn's continuation is ignored on the error branch.
test("bare turn_end continue does not resume an errored run", { timeout: 20000 }, async () => {
  const r = await runFixture(["enc", "ok"], { afterTurn: (event) => event.outcome === "error" ? { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }], continue: true } : undefined });
  assert.equal(r.requests.length, 1);
});
