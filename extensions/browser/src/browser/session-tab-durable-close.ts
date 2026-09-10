import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { ResolvedBrowserConfig } from "./config.js";
import type { BrowserSessionTabRecord } from "./session-tab-store.js";

export type DurableCleanupResult =
  | CloseTrackedCdpTargetResult
  | { status: "unavailable"; reason: "extension-relay-unavailable" };
export type ResolveBrowserTabCleanupConfig = () =>
  | ResolvedBrowserConfig
  | null
  | Promise<ResolvedBrowserConfig | null>;

export async function closeCurrentDurableTab(
  tab: BrowserSessionTabRecord,
  shouldClose: () => boolean,
  getResolvedBrowserConfig?: ResolveBrowserTabCleanupConfig,
): Promise<DurableCleanupResult> {
  // Empty session cleanup must not initialize Browser control or its CDP graph.
  const [{ getRuntimeConfig }, { resolveCdpControlPolicy }, { closeTrackedCdpTarget }, config] =
    await Promise.all([
      import("../config/config.js"),
      import("./cdp-reachability-policy.js"),
      import("./cdp.helpers.js"),
      import("./config.js"),
    ]);
  let resolved = await getResolvedBrowserConfig?.();
  if (!shouldClose()) {
    return { status: "cancelled" };
  }
  if (!resolved) {
    const cfg = getRuntimeConfig();
    resolved = config.resolveBrowserConfig(cfg.browser, cfg);
  }
  const profile = config.resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return { status: "ownership-mismatch" };
  }
  if (profile.driver === "extension" && !resolved.extensionRelayInternalTokens[profile.name]) {
    return { status: "unavailable", reason: "extension-relay-unavailable" };
  }
  const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
  return await closeTrackedCdpTarget({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    ssrfPolicy: cdpControlPolicy,
    expectedProfileFingerprint: tab.profileFingerprint,
    expectedBrowserInstanceFingerprint: tab.browserInstanceFingerprint,
    shouldClose,
  });
}
