// Read-only Tailscale pairing preflight findings.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { isTrustedProxyAddress } from "../gateway/net.js";
import { checkBrowserOrigin } from "../gateway/origin-check.js";
import { validateMobilePairingUrl, type resolvePairingGatewayUrl } from "../pairing/setup-code.js";
import type {
  TailscaleServeRouteObservation,
  inspectTailscaleServeRoutesWithRunner,
} from "../shared/tailscale-status.js";

export const TAILSCALE_PAIRING_CHECK_ID = "core/doctor/tailscale-pairing";

type PairingUrlResult = Awaited<ReturnType<typeof resolvePairingGatewayUrl>>;
type ServeInspection = Awaited<ReturnType<typeof inspectTailscaleServeRoutesWithRunner>>;

type TailscalePairingConfigurationInput = {
  cfg: OpenClawConfig;
  gatewayPort: number;
  pairingUrl: PairingUrlResult;
  serveInspection: ServeInspection;
};

function configPathForUrlSource(source: string | undefined): string | undefined {
  if (source === "plugins.entries.device-pair.config.publicUrl") {
    return source;
  }
  if (source === "gateway.remote.url") {
    return source;
  }
  if (source?.startsWith("gateway.tailscale.mode=")) {
    return "gateway.tailscale.mode";
  }
  return undefined;
}

function parsePairingUrl(raw: string | undefined): URL | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return (url.protocol === "ws:" || url.protocol === "wss:") && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): number {
  return Number.parseInt(url.port || (url.protocol === "wss:" ? "443" : "80"), 10);
}

function routeCoversPath(routePath: string, requestPath: string): boolean {
  if (routePath === "/") {
    return true;
  }
  const mount = routePath.endsWith("/") ? routePath.slice(0, -1) : routePath;
  return requestPath === mount || requestPath.startsWith(`${mount}/`);
}

function routeTargetsGateway(route: TailscaleServeRouteObservation, gatewayPort: number): boolean {
  if (!route.target) {
    return false;
  }
  const raw = route.target.includes("://") ? route.target : `http://${route.target}`;
  try {
    const target = new URL(raw);
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) &&
      Number.parseInt(target.port, 10) === gatewayPort
    );
  } catch {
    return false;
  }
}

function pairingTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function browserOrigin(url: URL): string {
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

function isLikelyTailscaleTarget(url: URL, cfg: OpenClawConfig): boolean {
  return (
    (cfg.gateway?.tailscale?.mode ?? "off") !== "off" ||
    url.hostname.toLowerCase().endsWith(".ts.net") ||
    /^100\.(?:6[4-9]|[78]\d|9[0-5])\./.test(url.hostname)
  );
}

/** Compares configured publication with a point-in-time Serve snapshot. */
export function collectTailscalePairingConfigurationFindings(
  params: TailscalePairingConfigurationInput,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  const sourcePath = configPathForUrlSource(params.pairingUrl.source);
  const url = parsePairingUrl(params.pairingUrl.url);
  if (!url) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message: params.pairingUrl.error
        ? `The mobile pairing endpoint could not be resolved: ${params.pairingUrl.error}`
        : "The mobile pairing endpoint could not be resolved from the current configuration.",
      ...(sourcePath ? { path: sourcePath } : {}),
      requirement: "pairing-url-resolved",
      fixHint:
        "Configure an explicit secure mobile endpoint or enable managed Tailscale Serve, then rerun this check.",
    });
    return findings;
  }

  const target = pairingTarget(url);
  const mobileUrlError = validateMobilePairingUrl(target, params.pairingUrl.source);
  if (mobileUrlError) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "error",
      message: mobileUrlError,
      ...(sourcePath ? { path: sourcePath } : {}),
      target,
      requirement: "secure-mobile-url",
      fixHint: "Publish the mobile endpoint with wss://, normally through Tailscale Serve.",
    });
  }

  const tailscaleRelevant = isLikelyTailscaleTarget(url, params.cfg);
  if (params.serveInspection.status !== "ok") {
    if (tailscaleRelevant) {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "warning",
        message:
          params.serveInspection.status === "invalid"
            ? "Tailscale Serve status returned malformed or unsupported JSON; route readiness is unknown."
            : "Tailscale Serve status is unavailable; route readiness is unknown.",
        target,
        requirement:
          params.serveInspection.status === "invalid"
            ? "serve-status-valid"
            : "serve-status-available",
        fixHint:
          "Run `tailscale serve status --json` as this user and resolve the CLI or daemon error before retrying.",
      });
    }
    return findings;
  }

  const port = effectivePort(url);
  const path = url.pathname || "/";
  const authorityRoutes = params.serveInspection.routes.filter(
    (route) =>
      route.host === url.hostname.toLowerCase() &&
      route.port === port &&
      routeCoversPath(route.path, path),
  );
  if (authorityRoutes.length === 0) {
    if (tailscaleRelevant) {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "warning",
        message:
          "No observed Tailscale Serve handler covers the configured mobile pairing endpoint.",
        target,
        requirement: "serve-route-present",
        fixHint:
          "Create or correct the exact Serve listener/path for this endpoint, preserving unrelated routes.",
      });
    }
    return findings;
  }

  const managedMode = params.cfg.gateway?.tailscale?.mode ?? "off";
  const gatewayRoutes = authorityRoutes.filter((route) =>
    routeTargetsGateway(route, params.gatewayPort),
  );
  if (managedMode === "off" && gatewayRoutes.length === 0) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "error",
      message:
        "The configured Tailscale listener/path is present, but none of its handlers target this Gateway listener.",
      target,
      requirement: "serve-route-target",
      fixHint: `Point only the intended handler at the local Gateway listener on port ${params.gatewayPort}; do not replace sibling routes.`,
    });
    return findings;
  }

  if (managedMode === "off") {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "info",
      message:
        "An externally managed Tailscale Serve route matches the mobile endpoint; gateway.tailscale.mode=off is valid for this arrangement.",
      target,
      requirement: "external-serve-route",
      fixHint:
        "Keep the external route and configure only its immediate proxy trust and normal Gateway authentication.",
    });

    const trustedProxies = params.cfg.gateway?.trustedProxies;
    const trustsLoopback =
      isTrustedProxyAddress("127.0.0.1", trustedProxies) ||
      isTrustedProxyAddress("::1", trustedProxies);
    if (!trustsLoopback) {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "error",
        message:
          "The external Serve route reaches the ordinary Gateway through loopback, but no loopback immediate proxy is trusted; WebSocket upgrade attribution can fail even when HTTP liveness succeeds.",
        path: "gateway.trustedProxies",
        target,
        requirement: "proxy-attribution",
        fixHint:
          "Trust only the loopback address used by the immediate Tailscale proxy and ensure it overwrites or safely rebuilds forwarded client headers.",
      });
    }

    if (
      gatewayRoutes.some((route) => route.funnel) &&
      (params.cfg.gateway?.auth?.mode ?? "none") === "none"
    ) {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "error",
        message:
          "The externally managed route is public Funnel ingress while Gateway authentication is disabled.",
        path: "gateway.auth.mode",
        target,
        requirement: "external-funnel-auth",
        fixHint: "Configure token, password, or trusted-proxy authentication before using Funnel.",
      });
    }
  }

  if (params.cfg.gateway?.controlUi?.enabled !== false) {
    const origin = browserOrigin(url);
    const originResult = checkBrowserOrigin({
      requestHost: url.host,
      origin,
      allowedOrigins: params.cfg.gateway?.controlUi?.allowedOrigins,
      allowHostHeaderOriginFallback:
        params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
      isLocalClient: false,
    });
    if (!originResult.ok) {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "warning",
        message: `The Control UI browser origin ${origin} is not accepted by current policy; Android pairing is unaffected by this browser-only finding.`,
        path: "gateway.controlUi.allowedOrigins",
        target: origin,
        requirement: "control-ui-origin",
        fixHint: "Add this exact HTTPS origin if the Control UI will be opened through it.",
      });
    }
  }

  return findings;
}
