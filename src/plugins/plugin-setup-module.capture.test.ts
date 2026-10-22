import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([true, undefined, false, "true"])(
  "captures the declared setup scope through manifest discovery (entryScoped=%s)",
  async (entryScoped) => {
    const rootDir = fs.realpathSync(tempDirs.make("setup-entry-capture-"));
    const source = path.join(rootDir, "setup-api.cjs");
    const runtime = path.join(rootDir, "runtime.cjs");
    fs.writeFileSync(source, 'module.exports = { read: () => require("./helper.cjs").value };');
    fs.writeFileSync(path.join(rootDir, "helper.cjs"), 'exports.value = "setup";');
    fs.writeFileSync(runtime, 'module.exports = { value: "runtime" };');
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "setup-fixture",
        configSchema: { type: "object" },
        setup: { requiresRuntime: true, entryScoped },
      }),
    );
    const cache = createPluginCache();
    const recovered = new PluginInstance("setup-fixture");
    const fullRuntime = new PluginInstance("setup-fixture");
    try {
      await withPluginCache(cache, async () => {
        const candidates = [
          { idHint: "setup-fixture", origin: "config" as const, rootDir, source },
        ];
        let record = loadPluginManifestRegistryCore({ candidates, installRecords: {} }).plugins[0]!;
        if (entryScoped === true) {
          const stateDir = tempDirs.make("setup-entry-index-");
          const index = loadInstalledPluginIndex({
            candidates,
            installRecords: {},
            env: { VITEST: "true" },
          });
          await writePersistedInstalledPluginIndex(index, { stateDir });
          const persisted = await readPersistedInstalledPluginIndex({ stateDir });
          expect(persisted).not.toBeNull();
          record = loadPluginManifestRegistryForInstalledIndex({
            index: persisted!,
            includeDisabled: true,
          }).plugins[0]!;
        }
        const load = getPluginSetupModuleLoader(record, source, rootDir);
        const module = load(source) as { read(): string };
        expect(module.read()).toBe("setup");
        const instance = [...cache.setupModules.values()][0]!;
        expect(instance.hasModuleSource(runtime)).toBe(entryScoped !== true);
        expect(record.setup).toEqual({
          requiresRuntime: true,
          ...(entryScoped === true ? { entryScoped: true } : {}),
        });
        if (entryScoped === true) {
          const recovery = instance.captureModuleLoaderRecovery();
          try {
            recovery.bind(recovered);
            expect(recovered.hasModuleSource(runtime)).toBe(false);
            expect((recovered.loadModule(source) as { read(): string }).read()).toBe("setup");
            expect(recovered.sourceDigest).toBe(instance.sourceDigest);
          } finally {
            recovery.dispose();
          }
          // A setup receipt must never admit the package-wide runtime generation.
          expect(() =>
            bindPluginInstanceModuleLoader({
              instance: fullRuntime,
              origin: "config",
              rootDir,
              source: runtime,
              expectedSourceDigest: instance.sourceDigest,
            }),
          ).toThrow(/source changed after installation/);
        }
      });
    } finally {
      await recovered.dispose();
      await fullRuntime.dispose();
      await retirePluginCache(cache);
    }
  },
);
