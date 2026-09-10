import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import type { RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";

export function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.volatile-cleanup",
    "openclaw.browser.session-tabs.active-durable-keys",
    "openclaw.browser.session-tabs.cold-native-activity",
    "openclaw.browser.session-tabs.interaction-storage-keys",
    "openclaw.browser.session-tabs.exact-interaction-storage-keys",
    "openclaw.browser.session-tabs.volatile-aliases",
    "openclaw.browser.session-tabs.exact-volatile-aliases",
  ]) {
    delete state[Symbol.for(name)];
  }
}

/** Isolated real SQLite ownership shared by registry and handoff cleanup suites. */
export function useSessionTabSqliteFixture() {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let freshModuleCounter = 0;

  function openStore(): PluginStateSyncKeyedStore<unknown> {
    return createPluginStateSyncKeyedStoreForTests("browser", {
      namespace: "browser.session-tabs",
      maxEntries: 5_000,
      overflowPolicy: "reject-new",
    });
  }

  function installRuntime(
    openSyncKeyedStore: (options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<unknown> = (
      options,
    ) => createPluginStateSyncKeyedStoreForTests("browser", options),
  ): void {
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: "/plugins/browser",
        config: {},
        runtime: {
          config: {},
          state: {
            openKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateKeyedStoreForTests("browser", options),
            openSyncKeyedStore,
          },
        } as unknown as OpenClawPluginApi["runtime"],
      }),
    );
  }

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?durable=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-tabs-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  return { openStore, installRuntime, freshRegistry };
}
