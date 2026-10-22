import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { createPluginCliLoadSession, loadPluginCliDescriptors } from "./cli-registry-loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

const officialIds = ["acpx", "discord", "brave", "tavily", "duckduckgo"] as const;
afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it("keeps official no-root-CLI declarations metadata-only while loading a legacy command", async () => {
  useNoBundledPlugins();
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const paths: string[] = [];
  for (const id of officialIds) {
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL(`../../extensions/${id}/openclaw.plugin.json`, import.meta.url),
        "utf8",
      ),
    );
    expect(manifest.cliCommands, `${id} must declare no root CLI commands`).toEqual([]);
    const fixture = writePlugin({
      id,
      filename: "index.cjs",
      body: 'throw new Error("metadata-only help must not execute this plugin");',
    });
    fs.writeFileSync(
      path.join(fixture.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        configSchema: { type: "object" },
        cliCommands: manifest.cliCommands,
      }),
    );
    paths.push(fixture.dir);
  }
  const legacy = writePlugin({
    id: "legacy-example",
    filename: "index.cjs",
    body: `module.exports = { id: "legacy-example", register(api) {
      api.registerCli(({ program }) => program.command("example"), {
        descriptors: [{ name: "example", description: "Legacy example", hasSubcommands: false }],
      });
    } };`,
  });
  paths.push(legacy.dir);
  const ids = [...officialIds, legacy.id];
  const session = createPluginCliLoadSession();
  try {
    expect(
      await loadPluginCliDescriptors({
        cfg: {
          plugins: {
            load: { paths },
            allow: ids,
            entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
          },
        },
        env: {
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        session,
      }),
    ).toEqual([{ name: "example", description: "Legacy example", hasSubcommands: false }]);
  } finally {
    session.close();
  }
});
