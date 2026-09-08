// Read-only Tailscale pairing preflight findings.
import os from "node:os";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { isTrustedProxyAddress } from "../gateway/net.js";
import { checkBrowserOrigin } from "../gateway/origin-check.js";
import { probeGateway as probeGatewayEndpoint } from "../gateway/probe.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { isTailnetIPv4, isTailnetIPv6 } from "../infra/tailnet.js";
import {
  resolveConfiguredPairingPublicUrl,
  resolvePairingGatewayUrl,
  validateMobilePairingUrl,
} from "../pairing/setup-code.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  inspectTailscaleServeRoutesWithRunner,
  type TailscaleStatusCommandRunner,
  type TailscaleServeRouteObservation,
} from "../shared/tailscale-status.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";

export const TAILSCALE_PAIRING_CHECK_ID = "core/doctor/tailscale-pairing";
const HTTP_LIVENESS_MAX_BODY_BYTES = 4 * 1024;

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

function gatewayRouteLoopbackHost(
  route: TailscaleServeRouteObservation,
  gatewayPort: number,
  gatewayTlsEnabled: boolean,
): string | null {
  if (!route.target) {
    return null;
  }
  const raw = route.target.includes("://") ? route.target : `http://${route.target}`;
  try {
    const target = new URL(raw);
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    const expectedProtocol = gatewayTlsEnabled ? "https:" : "http:";
    return loopback &&
      target.protocol === expectedProtocol &&
      Number.parseInt(target.port, 10) === gatewayPort
      ? host
      : null;
  } catch {
    return null;
  }
}

function pairingTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function browserOrigin(url: URL): string {
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

function isConfiguredManagedTailscalePublication(source: string | undefined): boolean {
  return source?.startsWith("gateway.tailscale.mode=") === true;
}

function isLikelyTailscaleTarget(url: URL, source: string | undefined): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    isConfiguredManagedTailscalePublication(source) ||
    hostname.endsWith(".ts.net") ||
    isTailnetIPv4(hostname) ||
    isTailnetIPv6(hostname)
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

  const tailscaleRelevant = isLikelyTailscaleTarget(url, params.pairingUrl.source);
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

  const configuredManagedPublication = isConfiguredManagedTailscalePublication(
    params.pairingUrl.source,
  );
  const hasForegroundRoute = authorityRoutes.some((route) => route.management === "foreground");
  if (configuredManagedPublication && !hasForegroundRoute) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message:
        "The configured managed Tailscale endpoint has no active foreground Serve claim; the observed matching route is persistent and may belong to another service or an older setup.",
      path: "gateway.tailscale.mode",
      target,
      requirement: "managed-route-active",
      fixHint:
        "Inspect the foreground Serve owner, resolve any listener conflict, and restart the Gateway without clearing unrelated persistent routes.",
    });
    return findings;
  }

  const gatewayRoutes = authorityRoutes.flatMap((route) => {
    const loopbackHost = gatewayRouteLoopbackHost(
      route,
      params.gatewayPort,
      params.cfg.gateway?.tls?.enabled === true,
    );
    return loopbackHost ? [{ loopbackHost, route }] : [];
  });
  const managedPublication =
    configuredManagedPublication ||
    ((params.cfg.gateway?.tailscale?.mode ?? "off") !== "off" &&
      port === 443 &&
      path === "/" &&
      authorityRoutes.some((route) => route.management === "foreground"));
  if (!managedPublication && gatewayRoutes.length === 0) {
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

  if (!managedPublication) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "info",
      message:
        "An externally managed Tailscale Serve route matches the mobile endpoint; gateway.tailscale.mode=off is a valid arrangement for this endpoint.",
      target,
      requirement: "external-serve-route",
      fixHint:
        "Keep the external route and configure only its immediate proxy trust and normal Gateway authentication.",
    });

    if ((params.cfg.gateway?.tailscale?.mode ?? "off") !== "off") {
      findings.push({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "warning",
        message:
          "The selected mobile endpoint is externally managed while Gateway-managed Tailscale exposure is also enabled; the Gateway will attempt a separate managed listener claim.",
        path: "gateway.tailscale.mode",
        target,
        requirement: "external-managed-mode",
        fixHint:
          "Set gateway.tailscale.mode=off if this external route is intentional, or remove the explicit public URL to use the managed endpoint.",
      });
    }

    const trustedProxies = params.cfg.gateway?.trustedProxies;
    const hasUntrustedProxy = gatewayRoutes.some(({ loopbackHost }) =>
      loopbackHost === "localhost"
        ? !(
            isTrustedProxyAddress("127.0.0.1", trustedProxies) ||
            isTrustedProxyAddress("::1", trustedProxies)
          )
        : !isTrustedProxyAddress(loopbackHost, trustedProxies),
    );
    if (hasUntrustedProxy) {
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
      gatewayRoutes.some(({ route }) => route.funnel) &&
      params.cfg.gateway?.auth?.mode === "none"
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

  return findings;
}

type CollectTailscalePairingHealthParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runCommandWithTimeout?: TailscaleStatusCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  fetchFn?: typeof fetch;
  probeGateway?: typeof probeGatewayEndpoint;
};

function healthUrlForPairingEndpoint(url: URL): string {
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${protocol}//${url.host}${basePath}/healthz`;
}

async function probeHttpLiveness(params: {
  url: URL;
  signal?: AbortSignal;
  fetchFn: typeof fetch;
}): Promise<"live" | "unverified"> {
  try {
    const response = await params.fetchFn(healthUrlForPairingEndpoint(params.url), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: params.signal,
    });
    if (response.status !== 200) {
      return "unverified";
    }
    const body = JSON.parse(
      (await readResponseWithLimit(response, HTTP_LIVENESS_MAX_BODY_BYTES)).toString("utf8"),
    ) as { ok?: unknown; status?: unknown };
    return body.ok === true && body.status === "live" ? "live" : "unverified";
  } catch {
    return "unverified";
  }
}

function sanitizeProbeReason(value: string | null | undefined): string | undefined {
  const cleaned = value ? redactSensitiveUrlLikeString(sanitizeTerminalText(value)).trim() : "";
  return cleaned ? truncateUtf16Safe(cleaned, 240) : undefined;
}

function runtimeEvidenceFindings(params: {
  url: URL;
  liveness: "live" | "unverified";
  probe: Awaited<ReturnType<typeof probeGatewayEndpoint>>;
}): HealthFinding[] {
  const target = pairingTarget(params.url);
  const findings: HealthFinding[] = [
    params.liveness === "live"
      ? {
          checkId: TAILSCALE_PAIRING_CHECK_ID,
          severity: "info",
          message:
            "The configured endpoint returned the Gateway HTTP liveness contract; this does not prove WebSocket authentication or phone reachability.",
          target,
          requirement: "http-liveness",
        }
      : {
          checkId: TAILSCALE_PAIRING_CHECK_ID,
          severity: "warning",
          message:
            "The configured endpoint did not return the expected Gateway HTTP liveness contract; HTTP liveness is unverified.",
          target,
          requirement: "http-liveness-unverified",
          fixHint:
            "Check the exact published path and `/healthz` response without relying on status 200 alone.",
        },
  ];

  const reason = sanitizeProbeReason(params.probe.close?.reason ?? params.probe.error);
  if (
    reason?.includes("proxy_attribution_required") ||
    params.probe.error?.includes("proxy_attribution_required")
  ) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "error",
      message:
        "The Gateway rejected the WebSocket upgrade because the immediate proxy could not be attributed, regardless of HTTP liveness.",
      path: "gateway.trustedProxies",
      target,
      requirement: "proxy-attribution-runtime",
      fixHint:
        "Trust only the immediate proxy address and make that proxy overwrite or safely rebuild forwarded client headers.",
    });
    return findings;
  }

  const authenticated =
    params.probe.ok && (params.probe.auth.role !== null || params.probe.auth.scopes.length > 0);
  if (authenticated) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "info",
      message:
        "The configured endpoint completed an authenticated read-only Gateway probe from this host; phone tailnet access still requires separate verification.",
      target,
      requirement: "gateway-authenticated",
    });
  } else if (params.probe.gatewayReached === true) {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message: `The endpoint returned a correlated Gateway response, but authentication was not verified${reason ? ` (${reason})` : ""}.`,
      target,
      requirement: "gateway-auth-unverified",
      fixHint:
        "Verify normal Gateway authentication and device approval; this diagnostic does not create pairing requests.",
    });
  } else {
    findings.push({
      checkId: TAILSCALE_PAIRING_CHECK_ID,
      severity: "warning",
      message: `No correlated Gateway WebSocket response was observed${reason ? ` (${reason})` : ""}.`,
      target,
      requirement: "gateway-unreachable",
      fixHint: "Check Tailscale connectivity, the published route, TLS, and the Gateway listener.",
    });
  }
  return findings;
}

function deadlineFinding(url: URL | null): HealthFinding {
  return {
    checkId: TAILSCALE_PAIRING_CHECK_ID,
    severity: "warning",
    message: "The Tailscale pairing diagnostic reached its overall deadline.",
    ...(url ? { target: pairingTarget(url) } : {}),
    requirement: "diagnostic-deadline",
    fixHint: "Run the focused check again after confirming the Tailscale CLI and endpoint respond.",
  };
}

/** Runs the opt-in, read-only Tailscale pairing preflight under one deadline. */
export async function collectTailscalePairingHealthFindings(
  params: CollectTailscalePairingHealthParams,
): Promise<readonly HealthFinding[]> {
  const env = params.env ?? process.env;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const operationController = new AbortController();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs,
    signal: operationController.signal,
    operation: "doctor-tailscale-pairing",
  });
  const runCommandWithTimeout: TailscaleStatusCommandRunner =
    params.runCommandWithTimeout ??
    ((argv, options) =>
      runUtf8CommandWithTimeout(argv, {
        ...options,
        signal,
        maxOutputBytes: 400_000,
      }));
  const findings: HealthFinding[] = [];
  let url: URL | null = null;

  try {
    const [pairingUrl, serveInspection] = await racePromiseWithAbortSignal(
      Promise.all([
        resolvePairingGatewayUrl(params.cfg, {
          env,
          publicUrl: resolveConfiguredPairingPublicUrl(params.cfg),
          runCommandWithTimeout,
          networkInterfaces: params.networkInterfaces ?? os.networkInterfaces,
        }),
        inspectTailscaleServeRoutesWithRunner(runCommandWithTimeout),
      ]),
      signal,
    );
    findings.push(
      ...collectTailscalePairingConfigurationFindings({
        cfg: params.cfg,
        gatewayPort: resolveGatewayPort(params.cfg, env),
        pairingUrl,
        serveInspection,
      }),
    );
    url = parsePairingUrl(pairingUrl.url);
    if (!url || validateMobilePairingUrl(pairingTarget(url), pairingUrl.source)) {
      return findings;
    }

    const remoteTlsFingerprint =
      pairingUrl.source === "gateway.remote.url"
        ? params.cfg.gateway?.remote?.tlsFingerprint
        : undefined;
    const [liveness, probe] = await racePromiseWithAbortSignal(
      Promise.all([
        probeHttpLiveness({
          url,
          signal,
          fetchFn: params.fetchFn ?? fetch,
        }),
        (params.probeGateway ?? probeGatewayEndpoint)({
          url: pairingTarget(url),
          timeoutMs,
          includeDetails: false,
          detailLevel: "none",
          suppressStoredDeviceAuth: true,
          auth: undefined,
          config: remoteTlsFingerprint
            ? {
                gateway: {
                  remote: { url: pairingTarget(url), tlsFingerprint: remoteTlsFingerprint },
                },
              }
            : {},
          env,
          signal,
        }),
      ]),
      signal,
    );
    findings.push(...runtimeEvidenceFindings({ url, liveness, probe }));
    return findings;
  } catch (error) {
    if (signal?.aborted) {
      findings.push(deadlineFinding(url));
      return findings;
    }
    throw error;
  } finally {
    operationController.abort();
    cleanup();
  }
}
