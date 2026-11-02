import assert from "node:assert/strict";
import test from "node:test";
import { ENC, runFixture } from "./helpers/fixture.mjs";

const STATE_TYPE = "pi-azure-compat:state:v1";
const itemIds = (p) => p.input.filter((x) => typeof x.id === "string").map((x) => x.id);

// Break caught: the command must affect the actual wire request without an error,
// and must not silently delete encrypted reasoning or tool-call linkage.
test("clean strips current history once, preserves payload contents and later fresh IDs", async () => {
  const supplied = [];
  const r = await runFixture(["ok", "ok"], {
    prompts: 2,
    mutatePayload: (p) => { supplied.push(JSON.parse(JSON.stringify(p))); },
    beforePrompt: async ({ session, requests }, i) => {
      if (i === 0) {
        await session.prompt("/azure-compat clean");
        assert.equal(requests.length, 0, "the command itself makes no provider call");
      }
    },
  });
  assert.equal(r.requests.length, 2);
  assert.deepEqual(itemIds(r.requests[0]), []);
  assert.equal(r.requests[0].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
  assert.equal(r.requests[0].input.find((x) => x.type === "function_call").call_id, "call_history");
  assert.equal(r.requests[0].input.find((x) => x.type === "function_call_output").call_id, "call_history");
  assert.deepEqual(r.requests[0].input, supplied[0].input.map(({ id: _id, ...item }) => item));
  assert.deepEqual(itemIds(r.requests[1]), ["msg_fresh"]);
  assert.equal(r.entries.filter((e) => e.type === "custom_message" || e.type === "context_edit").length, 0);
  const history = r.entries.find((e) => e.type === "message" && e.message.role === "assistant");
  assert.equal(JSON.parse(history.message.content[0].thinkingSignature).id, "rs_history");
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: clean must survive reload while pending, and keep the captured
// history IDs suppressed after use, even for errors outside the auto matcher.
test("manual clean after a masked resource error survives disk resume", async () => {
  const r = await runFixture(["masked-resource", "ok", "ok"], {
    prompts: 3, diskResume: true, restartAfterFirst: true,
    afterPrompt: async ({ session, requests }, i) => {
      if (i === 0) {
        assert.equal(requests.length, 1, "masked resource wording stays outside auto recovery");
        await session.prompt("/azure-compat clean");
        assert.equal(requests.length, 1);
      }
    },
  });
  assert.equal(r.requests.length, 3);
  assert.deepEqual(itemIds(r.requests[1]), []);
  assert.deepEqual(itemIds(r.requests[2]), ["msg_fresh"]);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a deliberate clean must work even when automatic recovery was off.
test("clean enables cleanup on an off branch", async () => {
  const r = await runFixture(["ok"], {
    beforePrompt: async ({ session }) => {
      await session.prompt("/azure-compat off");
      await session.prompt("/azure-compat clean");
    },
  });
  assert.deepEqual(itemIds(r.requests[0]), []);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: pending cleanup must not touch reference-mode history or be lost
// before the first request whose inline items can safely be replayed ID-free.
test("clean waits through an ineligible request", async () => {
  let request = 0;
  const r = await runFixture(["ok", "ok"], {
    prompts: 2,
    beforePrompt: async ({ session }, i) => { if (i === 0) await session.prompt("/azure-compat clean"); },
    mutatePayload: (p) => { if (request++ === 0) p.store = true; },
  });
  assert.deepEqual(itemIds(r.requests[0]), ["rs_history", "msg_history", "fc_history"]);
  assert.deepEqual(itemIds(r.requests[1]), []);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: an empty first eligible request must still consume the one-shot
// cleanup, otherwise IDs arriving later would be stripped unexpectedly.
test("clean is consumed even when no item IDs are present", async () => {
  let request = 0;
  const r = await runFixture(["ok", "ok"], {
    prompts: 2,
    beforePrompt: async ({ session }, i) => { if (i === 0) await session.prompt("/azure-compat clean"); },
    mutatePayload: (p) => { if (request++ === 0) for (const item of p.input) delete item.id; },
  });
  assert.deepEqual(itemIds(r.requests[0]), []);
  assert.deepEqual(itemIds(r.requests[1]), ["rs_history", "msg_history", "fc_history", "msg_fresh"]);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: reset must cancel both pending and previously captured cleanup.
for (const afterUse of [false, true]) test(`reset cancels manual clean (${afterUse ? "after use" : "while pending"})`, async () => {
  const r = await runFixture(["ok", "ok"], {
    prompts: 2,
    beforePrompt: async ({ session }, i) => {
      if (i === 0) await session.prompt("/azure-compat clean");
      if (i === (afterUse ? 1 : 0)) await session.prompt("/azure-compat reset");
    },
  });
  assert.equal(itemIds(r.requests[afterUse ? 0 : 1]).includes("rs_history"), !afterUse);
  assert.equal(itemIds(r.requests[1]).includes("rs_history"), true);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a command on one selected model must not strip another scope.
test("pending clean is isolated to the selected model scope", async () => {
  let original;
  const r = await runFixture(["ok", "ok"], {
    prompts: 2,
    mutatePayload: (p) => p.input.push({ type: "message", id: "scope_probe", role: "assistant", content: [] }),
    beforePrompt: async ({ session, modelRuntime, modelConfig, baseUrl }, i) => {
      if (i === 0) {
        original = modelRuntime.getModel("ReplayFixture", modelConfig.id);
        await session.prompt("/azure-compat clean");
        modelRuntime.registerProvider("OtherFixture", { api: "openai-responses", apiKey: "loopback-only", baseUrl, models: [modelConfig] });
        await session.setModel(modelRuntime.getModel("OtherFixture", modelConfig.id));
      } else await session.setModel(original);
    },
  });
  assert.equal(itemIds(r.requests[0]).includes("scope_probe"), true);
  assert.deepEqual(itemIds(r.requests[1]), []);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: an abandoned branch must not leak a pending clean into its parent.
test("branching before clean discards the pending operation", async () => {
  const r = await runFixture(["ok"], {
    beforePrompt: async ({ session, manager }) => {
      const leaf = manager.getLeafId();
      await session.prompt("/azure-compat clean");
      manager.branch(leaf);
    },
  });
  assert.deepEqual(itemIds(r.requests[0]), ["rs_history", "msg_history", "fc_history"]);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: unsupported APIs must not acquire a hidden cleanup operation.
test("clean rejects non-Responses models without changing policy", async () => {
  const r = await runFixture(["ok"], {
    beforePrompt: async ({ session, manager, modelRuntime, modelConfig, baseUrl }) => {
      modelRuntime.registerProvider("ChatFixture", { api: "openai-completions", apiKey: "loopback-only", baseUrl, models: [modelConfig] });
      await session.setModel(modelRuntime.getModel("ChatFixture", modelConfig.id));
      await session.prompt("/azure-compat clean");
      assert.equal(manager.getBranch().filter((e) => e.type === "custom" && e.customType === STATE_TYPE).length, 0);
      await session.setModel(modelRuntime.getModel("ReplayFixture", modelConfig.id));
    },
  });
  assert.deepEqual(itemIds(r.requests[0]), ["rs_history", "msg_history", "fc_history"]);
  assert.deepEqual(r.extensionErrors, []);
});
