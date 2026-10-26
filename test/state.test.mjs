import assert from "node:assert/strict";
import test from "node:test";
import { runFixture } from "./helpers/fixture.mjs";

// Break caught: controls that change UI only, or off still mutating known IDs.
test("on/off controls both recovery and known-ID cleanup", async () => {
  const r = await runFixture(["resource", "resource", "ok", "ok", "ok"], {
    prompts: 4,
    beforePrompt: async ({ session }, i) => { await session.prompt(`/azure-compat ${i === 0 || i === 2 ? "off" : "on"}`); },
  });
  assert.equal(r.requests.length, 5);
  assert.equal(r.requests[0].input.some((x) => x.id === "rs_history"), true);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), true);
  assert.equal(r.requests[2].input.some((x) => x.id === "rs_history"), false);
  assert.equal(r.requests[3].input.some((x) => x.id === "rs_history"), true);
  assert.equal(r.requests[4].input.some((x) => x.id === "rs_history"), false);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: rejection knowledge disappearing when a JSONL session is reopened.
test("disk resume restores rejected IDs", async () => {
  const r = await runFixture(["resource", "ok", "ok"], { prompts: 2, diskResume: true, restartAfterFirst: true });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].input.some((x) => x.id === "rs_history"), false);
  assert.equal(r.requests[2].input.some((x) => x.id === "msg_fresh"), true);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: reload silently re-enabling a persisted off branch.
test("off survives disk resume, then on permits a recovery", async () => {
  const r = await runFixture(["resource", "resource", "resource", "ok"], {
    prompts: 3, diskResume: true, restartAfterFirst: true,
    beforePrompt: async ({ session }, i) => { if (i === 0 || i === 2) await session.prompt(`/azure-compat ${i === 0 ? "off" : "on"}`); },
  });
  assert.equal(r.requests.length, 4);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), true);
  assert.equal(r.requests[3].input.some((x) => x.id === "rs_history"), false);
});

// Break caught: reset clearing counters but leaving the blocked-ID policy active.
test("reset restores raw IDs for the current scope", async () => {
  const r = await runFixture(["resource", "ok", "ok"], {
    prompts: 2,
    beforePrompt: async ({ session }, i) => { if (i === 1) await session.prompt("/azure-compat reset"); },
  });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), false);
  assert.equal(r.requests[2].input.some((x) => x.id === "rs_history"), true);
});

// Break caught: a fresh injected identity keeping recovery alive indefinitely.
test("at most one identity continuation per prompt even if new IDs keep appearing", async () => {
  let serial = 0;
  const r = await runFixture(["resource", "resource", "ok"], {
    mutatePayload: (p) => p.input.push({ type: "message", id: `msg_injected_${++serial}`, role: "assistant", content: [] }),
  });
  assert.equal(r.requests.length, 2);
});

test("a new prompt gets a new bounded recovery budget", async () => {
  let serial = 0;
  const r = await runFixture(["resource", "resource", "resource", "ok"], {
    prompts: 2,
    mutatePayload: (p) => p.input.push({ type: "message", id: `msg_injected_${++serial}`, role: "assistant", content: [] }),
  });
  assert.equal(r.requests.length, 4);
  assert.equal(r.requests[2].input.some((x) => x.id === "rs_history"), false);
});

// Break caught: persistence keyed only by model name or provider.
for (const dimension of ["provider", "model", "endpoint"]) test(`rejected IDs are isolated by ${dimension}`, async () => {
  const r = await runFixture(["resource", "ok", "ok"], {
    prompts: 2,
    mutatePayload: (p) => p.input.push({ type: "message", id: "scope_probe", role: "assistant", content: [] }),
    beforePrompt: async ({ session, modelRuntime, modelConfig, baseUrl }, i) => {
      if (i !== 1) return;
      const provider = dimension === "provider" ? "OtherFixture" : "ReplayFixture";
      const model = { ...modelConfig, id: dimension === "model" ? "gpt-another-fixture" : modelConfig.id };
      modelRuntime.registerProvider(provider, { api: "openai-responses", apiKey: "loopback-only", baseUrl: dimension === "endpoint" ? `${baseUrl}/other` : baseUrl, models: [model] });
      await session.setModel(modelRuntime.getModel(provider, model.id));
    },
  });
  assert.equal(r.requests.length, 3);
  assert.equal(r.requests[2].input.some((x) => x.id === "scope_probe"), true);
});

// Break caught: cleanup deleting IDs in the original payload/history object.
test("cleanup replaces wire items without mutating the payload supplied by earlier handlers", async () => {
  const captured = [];
  const r = await runFixture(["resource", "ok"], { mutatePayload: (p) => { captured.push(p); } });
  assert.equal(r.requests.length, 2);
  assert.equal(captured[1].input.some((x) => x.id === "rs_history"), true);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), false);
});

test("ordinary item-not-found errors are not reclassified as the Azure resource error", async () => {
  const r = await runFixture(["ordinary-id-error", "ok"]);
  assert.equal(r.requests.length, 1);
});

test("a payload for another model is left alone", async () => {
  const r = await runFixture(["resource", "ok"], { mutatePayload: (p) => { p.model = "different-model"; } });
  assert.equal(r.requests.length, 1);
});

// Break caught: sending the request twice when an earlier recovery already owns it.
test("an existing settlement continuation is respected", async () => {
  let handled = false;
  const r = await runFixture(["resource", "ok"], { precedingExtension: (pi) => {
    pi.on("agent_before_settle", (event) => {
      if (handled || event.outcome !== "error") return;
      handled = true;
      const entry = event.context.contextEntries.findLast((x) => x.messages.some((m) => m.role === "assistant"));
      return { entries: [{ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null }], continue: true };
    });
  } });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), true);
});
