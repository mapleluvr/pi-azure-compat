import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// Break caught: manifest/entry-point errors hidden by inline-factory integration tests.
test("Pi discovers and loads the package manifest entry point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-azure-package-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const settingsManager = SettingsManager.inMemory({ packages: [root] });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.some((extension) => extension.commands.has("azure-compat")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
