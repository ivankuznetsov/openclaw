import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
// Browser plugin runtime state shared across lazy bundles and duplicate SDK module instances.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

export type BrowserTabCleanupGate = {
  acquire(browser: {
    target: "host";
    profile: string;
    targetId: string;
  }): Promise<(() => Promise<void>) | undefined>;
};

type BrowserStateRuntime = {
  sessionTabs: PluginStateSyncKeyedStore<unknown>;
  tabCleanupGate?: BrowserTabCleanupGate;
};

const {
  setRuntime: setBrowserStateRuntime,
  getRuntime: getBrowserStateRuntime,
  tryGetRuntime: getOptionalBrowserStateRuntime,
} = createPluginRuntimeStore<BrowserStateRuntime>({
  pluginId: "browser",
  errorMessage: "Browser state runtime not initialized",
});

export { getBrowserStateRuntime, getOptionalBrowserStateRuntime, setBrowserStateRuntime };
