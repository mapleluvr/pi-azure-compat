// Failure-chain contracts exercised through real Pi turns and loopback Responses.
import assert from "node:assert/strict";
import test from "node:test";
import { ENC, TOOL_ENC, runFixture } from "./helpers/fixture.mjs";

const rejectedEntries = (r) => r.entries.filter((e) => e.type === "custom" && e.customType === "pi-azure-compat:state:v1" && e.data.kind === "rejected");
const statusOf = (r) => r.notifications.findLast((n) => n.message.startsWith("pi-azure-compat:"))?.message;
const withStatus = { captureNotifications: true, afterPrompt: async ({ session }) => session.prompt("/azure-compat status") };

// Break caught: an operation-wide cap prevents repairing new IDs after successful
// tool turns, or resetting the cap accidentally resurrects old rejected IDs.
for (const error of ["resource", "router-masked-resource"]) {
  test(`successful tool turns renew the repair allowance for each failure chain (${error})`, { timeout: 20000 }, async () => {
    const r = await runFixture([error, "tool-1", error, "tool-2", error, "ok"], withStatus);
    assert.equal(r.requests.length, 6, "all three failures should recover within one prompt");
    assert.deepEqual(r.requests.map((p) => p.input.filter((x) => typeof x.id === "string").length), [3, 0, 3, 0, 3, 0]);
    assert.deepEqual(rejectedEntries(r).map((e) => e.data.ids), [
      ["rs_history", "msg_history", "fc_history"],
      ["rs_tool_1", "msg_tool_1", "fc_tool_1"],
      ["rs_tool_2", "msg_tool_2", "fc_tool_2"],
    ]);
    assert.equal(r.requests[5].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
    const freshReasoning = r.requests[5].input.filter((x) => x.type === "reasoning").slice(1);
    assert.equal(freshReasoning.length, 2);
    assert.deepEqual(freshReasoning.map((x) => x.encrypted_content), [TOOL_ENC, TOOL_ENC]);
    assert.deepEqual(r.requests[5].input.filter((x) => x.type === "function_call").map((x) => x.call_id), ["call_history", "call_tool_1", "call_tool_2"]);
    assert.deepEqual(r.requests[5].input.filter((x) => x.type === "function_call_output").map((x) => x.call_id), ["call_history", "call_tool_1", "call_tool_2"]);
    assert.equal(r.entries.filter((e) => e.type === "context_edit").length, 3);
    assert.equal(r.notifications.filter((n) => n.message.includes("identity mismatch")).length, 3);
    assert.match(statusOf(r), /3 recoveries/);
    assert.equal(r.lastText, "fixture-ok");
    const rawFresh = r.entries.find((e) => e.type === "message" && e.message.content?.some?.((b) => b.type === "toolCall" && b.id === "call_tool_1|fc_tool_1"));
    assert.ok(rawFresh);
    assert.equal(JSON.parse(rawFresh.message.content.find((b) => b.type === "thinking").thinkingSignature).id, "rs_tool_1");
    assert.equal(JSON.parse(rawFresh.message.content.find((b) => b.type === "text").textSignature).id, "msg_tool_1");
    assert.deepEqual(r.extensionErrors, []);
  });
}

// Break caught: only toolUse, rather than any normally completed main response,
// renews the allowance; a prior successful-turn continuation must not block renewal.
test("a completed text response renews the allowance before an owner's continuation", { timeout: 20000 }, async () => {
  let turns = 0;
  const r = await runFixture(["resource", "ok", "resource", "ok"], {
    ...withStatus,
    afterTurn: (event) => {
      if (++turns === 2 && event.outcome === "completed") return {
        entries: [{ type: "custom_message", customType: "fixture_continue", content: "Continue.", display: false }],
        continue: true,
      };
    },
  });
  assert.equal(r.requests.length, 4);
  assert.equal(rejectedEntries(r).length, 2);
  assert.deepEqual(rejectedEntries(r)[1].data.ids, ["msg_fresh"]);
  assert.deepEqual(r.requests[3].input.filter((x) => typeof x.id === "string"), []);
  assert.equal(r.lastText, "fixture-ok");
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a completed response attributed to a different provider/API/model
// is accepted as progress for the captured main request.
for (const [name, patch] of [
  ["provider", { provider: "OtherFixture" }],
  ["API", { api: "openai-completions" }],
  ["model", { model: "gpt-unrelated" }],
]) test(`mismatched response ${name} does not renew the allowance`, { timeout: 20000 }, async () => {
  let serial = 0;
  const r = await runFixture(["resource", "tool-1", "resource", "ok"], {
    ...withStatus,
    mutatePayload: (p) => p.input.push({ type: "message", id: `msg_unverified_${++serial}`, role: "assistant", content: [] }),
    precedingExtension: (pi) => pi.on("message_end", (event) => {
      if (event.message.role === "assistant" && event.message.stopReason === "toolUse") return { message: { ...event.message, ...patch } };
    }),
  });
  assert.equal(r.requests.length, 3);
  assert.equal(rejectedEntries(r).length, 1);
  assert.match(statusOf(r), /strict \(budget\)/);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a completed response with ambiguous provider-hook correlation
// resets the chain even though the captured request was invalidated.
test("multiple provider hooks on a successful turn do not renew the allowance", { timeout: 20000 }, async () => {
  let session, hooks = 0, serial = 0;
  const r = await runFixture(["resource", "tool-1", "resource", "ok"], {
    ...withStatus,
    beforePrompt: (fixture) => { session = fixture.session; },
    mutatePayload: (p) => p.input.push({ type: "message", id: `msg_unverified_${++serial}`, role: "assistant", content: [] }),
    trailingExtension: (pi) => pi.on("before_provider_request", async ({ payload }) => {
      if (++hooks === 2) await session.extensionRunner.emitBeforeProviderRequest(payload);
    }),
  });
  assert.equal(r.requests.length, 3);
  assert.equal(rejectedEntries(r).length, 1);
  assert.match(statusOf(r), /strict \(budget\)/);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: an ineligible request still grants the inline-Responses plugin
// another automatic repair just because its response completed.
test("a successful reference-mode request does not renew the allowance", { timeout: 20000 }, async () => {
  let serial = 0;
  const r = await runFixture(["resource", "tool-1", "resource", "ok"], {
    ...withStatus,
    mutatePayload: (p) => { if (++serial === 2) p.store = true; },
  });
  assert.equal(r.requests.length, 3);
  assert.equal(rejectedEntries(r).length, 1);
  assert.match(statusOf(r), /strict \(budget\)/);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: renewed allowance ignores an abort before the next rejection.
test("abort before the second failure boundary prevents a second repair", { timeout: 20000 }, async () => {
  let requests;
  const r = await runFixture(["resource", "tool-1", "resource", "ok"], {
    beforePrompt: (fixture) => { requests = fixture.requests; },
    precedingExtension: (pi) => pi.on("message_end", (event, ctx) => {
      if (requests.length === 3 && event.message.role === "assistant" && event.message.stopReason === "error") ctx.abort();
    }),
  });
  assert.equal(r.requests.length, 3);
  assert.equal(rejectedEntries(r).length, 1);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a second confirmed rejection is lost on abort/resume, or the
// renewed allowance supplies an unwanted continuation after cancellation.
test("abort after the second repair keeps its new rejected IDs across disk resume", { timeout: 20000 }, async () => {
  let requests, aborted = false;
  const r = await runFixture(["resource", "tool-1", "resource", "ok"], {
    prompts: 2, diskResume: true, restartAfterFirst: true,
    beforePrompt: (fixture) => { requests = fixture.requests; },
    trailingExtension: (pi) => pi.on("turn_end", (event, ctx) => {
      if (!aborted && requests.length === 3 && event.outcome === "error") { aborted = true; ctx.abort(); }
    }),
    afterPrompt: (fixture, index) => {
      if (index === 0) {
        assert.equal(fixture.requests.length, 3, "abort must not start a fourth request");
        assert.equal(fixture.manager.getBranch().filter((e) => e.customType === "pi-azure-compat:state:v1" && e.data.kind === "rejected").length, 2);
      }
    },
  });
  assert.equal(r.requests.length, 4);
  assert.equal(rejectedEntries(r).length, 2);
  assert.deepEqual(r.requests[3].input.filter((x) => typeof x.id === "string"), []);
  assert.equal(r.requests[3].input.filter((x) => x.type === "reasoning")[1].encrypted_content, TOOL_ENC);
  assert.deepEqual(r.extensionErrors, []);
});
