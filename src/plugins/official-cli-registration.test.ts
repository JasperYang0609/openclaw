import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import type { OpenClawPluginApi } from "./types.js";

// Actual public entries register into an inert API: no services, tools, or network execute.
it.each(["acpx", "discord", "brave", "tavily", "duckduckgo"])(
  "%s root CLI metadata agrees with actual registration",
  async (id) => {
    const source = fileURLToPath(new URL(`../../extensions/${id}/index.ts`, import.meta.url));
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL(`../../extensions/${id}/openclaw.plugin.json`, import.meta.url),
        "utf8",
      ),
    );
    const cache = createPluginCache();
    try {
      withPluginCache(cache, () => {
        const load = getCachedPluginModuleLoader({
          modulePath: source,
          importerUrl: import.meta.url,
          pluginSdkResolution: "src",
        });
        const entry = load(source) as { default: { register(api: OpenClawPluginApi): void } };
        const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
        const unexpectedStateAccess = vi.fn(() => {
          throw new Error("Registration must not execute state operations");
        });
        entry.default.register(
          createTestPluginApi({
            id,
            registerCli,
            runtime: {
              state: {
                openKeyedStore: () => ({
                  observe: unexpectedStateAccess,
                  compareAndApply: unexpectedStateAccess,
                }),
              },
            } as OpenClawPluginApi["runtime"],
          }),
        );
        expect(unexpectedStateAccess).not.toHaveBeenCalled();
        expect(registerCli).not.toHaveBeenCalled();
        expect(manifest.cliCommands).toEqual([]);
      });
    } finally {
      await retirePluginCache(cache);
    }
  },
);

it("keeps ACPX setup auto-enable reasons for enabled, dispatch, and backend selection", async () => {
  const source = fileURLToPath(new URL("../../extensions/acpx/setup-api.ts", import.meta.url));
  const cache = createPluginCache();
  try {
    withPluginCache(cache, () => {
      const load = getCachedPluginModuleLoader({
        modulePath: source,
        importerUrl: import.meta.url,
        pluginSdkResolution: "src",
      });
      const entry = load(source) as { default: { register(api: OpenClawPluginApi): void } };
      const probes: Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0][] = [];
      entry.default.register(
        createTestPluginApi({
          registerAutoEnableProbe: (probe) => {
            probes.push(probe);
          },
        }),
      );
      expect(probes).toHaveLength(1);
      const cases: Array<[OpenClawPluginApi["config"], string | null]> = [
        [{}, null],
        [{ acp: { enabled: false } }, null],
        [{ acp: { enabled: true } }, "ACP runtime configured"],
        [{ acp: { dispatch: { enabled: true } } }, "ACP runtime configured"],
        [{ acp: { backend: "" } }, null],
        [{ acp: { enabled: true, backend: "" } }, "ACP runtime configured"],
        [{ acp: { backend: "ACPX" } }, "ACP runtime configured"],
        [{ acp: { backend: " acpx " } }, "ACP runtime configured"],
        [{ acp: { enabled: true, backend: "other" } }, null],
        [{ acp: { dispatch: { enabled: true }, backend: "other" } }, null],
      ];
      for (const [config, expected] of cases) {
        expect(probes[0]!({ config, env: {} })).toBe(expected);
      }
    });
  } finally {
    await retirePluginCache(cache);
  }
});

afterEach(() => vi.restoreAllMocks());
