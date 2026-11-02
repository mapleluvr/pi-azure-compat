import assert from "node:assert/strict";
import test from "node:test";
import { ENC, runFixture } from "./helpers/fixture.mjs";

const STATE_TYPE = "pi-azure-compat:state:v1";
const rejectedEntries = (r) => r.entries.filter((e) => e.type === "custom" && e.customType === STATE_TYPE && e.data.kind === "rejected");

// The real SDK queue operation used by pi-retry, without its UI/config/log side effects.
function queuedFallback(maxRetries) {
  let attempts = 0;
  return (pi) => {
    pi.on("agent_end", (event) => {
      const message = event.messages.findLast((m) => m.role === "assistant");
      if (message?.stopReason !== "error" || attempts >= maxRetries) return;
      attempts++;
      pi.sendMessage({ customType: "__retry_trigger", content: "Retrying.", display: false }, { triggerTurn: true });
    });
    pi.on("context", (event) => ({ messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === "__retry_trigger")) }));
  };
}

// Break caught: waiting until settlement to register rejected IDs starves the repair
// while the generic agent_end fallback keeps queuing unmodified requests.
for (const order of ["retry-first", "repair-first"]) {
  for (const error of ["resource", "router-resource"]) {
    test(`queued fallback sends its first retry ID-free (${order}, ${error})`, async () => {
      const r = await runFixture([error, "ok"], {
        [order === "retry-first" ? "precedingExtension" : "trailingExtension"]: queuedFallback(1000),
      });
      assert.equal(r.requests.length, 2, "reuse the queued retry, do not add a third call");
      assert.equal(r.requests[0].input.filter((x) => typeof x.id === "string").length, 3);
      assert.equal(r.requests[1].input.filter((x) => typeof x.id === "string").length, 0);
      assert.equal(r.requests[1].input.find((x) => x.type === "reasoning").encrypted_content, ENC);
      assert.equal(r.requests[1].input.find((x) => x.type === "function_call").call_id, "call_history");
      assert.equal(r.requests[1].input.find((x) => x.type === "function_call_output").call_id, "call_history");
      assert.equal(rejectedEntries(r).length, 1);
      assert.equal(r.entries.filter((e) => e.type === "context_edit").length, 1);
      assert.equal(r.lastText, "fixture-ok");
      assert.deepEqual(r.extensionErrors, []);
    });
  }
}

// Break caught: a failed already-cleaned retry causing a second identity repair
// or an extra settlement request after the generic fallback budget ends.
test("queued fallback and standalone continuation share one identity-repair budget", async () => {
  let serial = 0;
  const r = await runFixture(["resource", "resource", "ok"], {
    precedingExtension: queuedFallback(1),
    mutatePayload: (p) => p.input.push({ type: "message", id: `msg_new_${++serial}`, role: "assistant", content: [] }),
  });
  assert.equal(r.requests.length, 2);
  assert.equal(rejectedEntries(r).length, 1);
  assert.deepEqual(r.requests[1].input.filter((x) => typeof x.id === "string").map((x) => x.id), ["msg_new_2"]);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: disabling compatibility only stops the standalone continuation,
// while a generic queued retry still triggers ID cleanup or persistent state.
test("off leaves queued fallback requests and state untouched", async () => {
  const r = await runFixture(["router-resource", "ok"], {
    precedingExtension: queuedFallback(1000),
    beforePrompt: async ({ session }) => { await session.prompt("/azure-compat off"); },
  });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.filter((x) => typeof x.id === "string").length, 3);
  assert.equal(rejectedEntries(r).length, 0);
  assert.equal(r.entries.filter((e) => e.type === "context_edit").length, 0);
});

// Break caught: a prior turn boundary owner must not be overridden or shadowed
// by staging a repair for a projected-away failure.
test("an earlier turn boundary owner prevents identity staging", async () => {
  const r = await runFixture(["resource", "ok"], {
    precedingExtension: (pi) => {
      pi.on("turn_end", (event) => event.outcome === "error"
        ? { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }], continue: true }
        : undefined);
    },
  });
  assert.equal(r.requests.length, 1);
  assert.equal(rejectedEntries(r).length, 0);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a cancellation before the rejection is finalized must not stage IDs.
test("abort before the turn boundary leaves rejected-ID state empty", async () => {
  const r = await runFixture(["router-resource", "ok"], {
    precedingExtension: (pi) => {
      pi.on("message_end", (event, ctx) => {
        if (event.message.role === "assistant" && event.message.stopReason === "error") ctx.abort();
      });
    },
  });
  assert.equal(r.requests.length, 1);
  assert.equal(rejectedEntries(r).length, 0);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: an abort after the confirmed rejection stops new requests but
// must not lose the recorded bad identities when the disk session is resumed.
test("abort after staging preserves rejected IDs across disk resume", async () => {
  const r = await runFixture(["router-resource", "ok"], {
    prompts: 2, abortAtEnd: true, diskResume: true, restartAfterFirst: true,
  });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.some((x) => typeof x.id === "string"), false);
  assert.equal(rejectedEntries(r).length, 1);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: reset between staging and settlement must invalidate the pending
// standalone continuation as well as the persisted ID policy.
test("reset after staging cancels the pending standalone continuation", async () => {
  let session;
  const r = await runFixture(["router-resource", "ok"], {
    prompts: 2,
    beforePrompt: (fixture) => { session = fixture.session; },
    trailingExtension: (pi) => {
      pi.on("agent_end", async (event) => {
        if (event.messages.findLast((m) => m.role === "assistant")?.stopReason === "error") await session.prompt("/azure-compat reset");
      });
    },
    afterPrompt: (fixture, index) => { if (index === 0) assert.equal(fixture.requests.length, 1); },
  });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.filter((x) => typeof x.id === "string").length, 3);
  assert.equal(rejectedEntries(r).length, 1);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: a second provider hook inside one turn invalidates request/error
// correlation, even when the last payload resembles the selected model.
test("multiple provider hooks in one turn prevent identity staging", async () => {
  let session, nested = false;
  const r = await runFixture(["router-resource", "ok"], {
    beforePrompt: (fixture) => { session = fixture.session; },
    trailingExtension: (pi) => {
      pi.on("before_provider_request", async ({ payload }) => {
        if (nested) return;
        nested = true;
        await session.extensionRunner.emitBeforeProviderRequest(payload);
      });
    },
  });
  assert.equal(r.requests.length, 1);
  assert.equal(rejectedEntries(r).length, 0);
  assert.deepEqual(r.extensionErrors, []);
});

// Break caught: even when the fallback ultimately succeeds, partial output and
// reference-mode requests must never be marked for identity stripping.
for (const [name, behavior, mutatePayload] of [
  ["partial output", "partial-resource", undefined],
  ["referenced history", "router-resource", (p) => { p.store = true; }],
]) test(`queued fallback does not broaden eligibility: ${name}`, async () => {
  const r = await runFixture([behavior, "ok"], { precedingExtension: queuedFallback(1000), mutatePayload });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].input.some((x) => x.id === "rs_history"), true);
  assert.equal(rejectedEntries(r).length, 0);
  assert.deepEqual(r.extensionErrors, []);
});
