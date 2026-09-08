import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TailscaleServeRouteObservation } from "../shared/tailscale-status.js";
import {
  TAILSCALE_PAIRING_CHECK_ID,
  collectTailscalePairingConfigurationFindings,
  collectTailscalePairingHealthFindings,
} from "./doctor-tailscale-pairing.js";

const externalRoute: TailscaleServeRouteObservation = {
  management: "background",
  host: "node.tail.ts.net",
  port: 18789,
  path: "/",
  target: "http://127.0.0.1:18789",
  funnel: false,
};

function findings(
  cfg: OpenClawConfig,
  options: {
    url?: string;
    source?: string;
    error?: string;
    routes?: TailscaleServeRouteObservation[];
    status?: "ok" | "invalid" | "unavailable";
  } = {},
) {
  const status = options.status ?? "ok";
  return collectTailscalePairingConfigurationFindings({
    cfg,
    gatewayPort: 18789,
    pairingUrl: {
      url: options.url ?? "wss://node.tail.ts.net:18789",
      source: options.source ?? "plugins.entries.device-pair.config.publicUrl",
      ...(options.error ? { error: options.error } : {}),
    },
    serveInspection:
      status === "ok" ? { status, routes: options.routes ?? [externalRoute] } : { status },
  });
}

describe("doctor Tailscale pairing preflight configuration", () => {
  it("recognizes a deliberate external Serve route while managed mode is off", () => {
    const result = findings({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "off" },
        trustedProxies: ["127.0.0.1/32"],
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        checkId: TAILSCALE_PAIRING_CHECK_ID,
        severity: "info",
        requirement: "external-serve-route",
        target: "wss://node.tail.ts.net:18789",
      }),
    ]);
  });

  it("reports missing immediate loopback proxy trust independently of route liveness", () => {
    const result = findings({ gateway: { bind: "loopback", tailscale: { mode: "off" } } });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          path: "gateway.trustedProxies",
          requirement: "proxy-attribution",
        }),
      ]),
    );
    expect(result.find((entry) => entry.requirement === "proxy-attribution")?.fixHint).toContain(
      "loopback",
    );
  });

  it("reports a matching listener whose handler targets a different service", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "off" } } },
      {
        routes: [{ ...externalRoute, target: "http://127.0.0.1:8096" }],
      },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          requirement: "serve-route-target",
          target: "wss://node.tail.ts.net:18789",
        }),
      ]),
    );
    expect(result.map((entry) => entry.message).join(" ")).not.toContain("8096");
  });

  it("flags an insecure raw tailnet WebSocket URL", () => {
    const result = findings(
      { gateway: { bind: "tailnet", tailscale: { mode: "off" } } },
      { url: "ws://100.64.0.9:18789", source: "gateway.remote.url", routes: [] },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          requirement: "secure-mobile-url",
          path: "gateway.remote.url",
        }),
      ]),
    );
  });

  it.each(["invalid", "unavailable"] as const)(
    "keeps %s Serve status distinct from an empty route set",
    (status) => {
      const result = findings({ gateway: { tailscale: { mode: "off" } } }, { status });

      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            requirement: status === "invalid" ? "serve-status-valid" : "serve-status-available",
          }),
        ]),
      );
    },
  );

  it("reports browser origin policy separately from native pairing", () => {
    const route = { ...externalRoute, host: "gateway.example.com" };
    const result = findings(
      {
        gateway: {
          bind: "loopback",
          tailscale: { mode: "off" },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://other.example.com"] },
        },
      },
      { url: "wss://gateway.example.com:18789", routes: [route] },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          requirement: "control-ui-origin",
          path: "gateway.controlUi.allowedOrigins",
        }),
      ]),
    );
    expect(result.find((entry) => entry.requirement === "control-ui-origin")?.message).toContain(
      "Android pairing is unaffected",
    );
  });

  it("does not require ordinary-listener proxy trust for managed ingress", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "serve" } } },
      { source: "gateway.tailscale.mode=serve" },
    );

    expect(result.some((entry) => entry.requirement === "proxy-attribution")).toBe(false);
  });

  it("does not expose unrelated route details when the configured route is absent", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "off" } } },
      {
        routes: [
          {
            ...externalRoute,
            host: "other.tail.ts.net",
            target: "http://127.0.0.1:9999/private",
          },
        ],
      },
    );

    expect(result).toEqual([
      expect.objectContaining({ severity: "warning", requirement: "serve-route-present" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("9999");
  });
});

describe("doctor Tailscale pairing preflight runtime evidence", () => {
  const cfg = {
    gateway: {
      bind: "loopback",
      tailscale: { mode: "off" },
      trustedProxies: ["127.0.0.1"],
    },
    plugins: {
      entries: {
        "device-pair": { config: { publicUrl: "wss://node.tail.ts.net:18789" } },
      },
    },
  } as OpenClawConfig;

  function serveRunner() {
    return vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "18789": { HTTPS: true } },
        Web: {
          "node.tail.ts.net:18789": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
          },
        },
      }),
    });
  }

  it("keeps HTTP liveness separate from a WebSocket attribution failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const probe = vi.fn().mockResolvedValue({
      ok: false,
      gatewayReached: true,
      url: "wss://node.tail.ts.net:18789",
      connectLatencyMs: 15,
      error: "gateway closed (1008): proxy_attribution_required",
      close: { code: 1008, reason: "proxy_attribution_required" },
      auth: { role: null, scopes: [], capability: "unknown" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn,
      probeGateway: probe,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "info", requirement: "http-liveness" }),
        expect.objectContaining({ severity: "error", requirement: "proxy-attribution-runtime" }),
      ]),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://node.tail.ts.net:18789/healthz",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://node.tail.ts.net:18789",
        includeDetails: false,
        detailLevel: "none",
        suppressStoredDeviceAuth: true,
        auth: undefined,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports a correlated unauthenticated Gateway response as auth unverified", async () => {
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi.fn().mockResolvedValue(new Response("not the Gateway", { status: 200 })),
      probeGateway: vi.fn().mockResolvedValue({
        ok: false,
        gatewayReached: true,
        url: "wss://node.tail.ts.net:18789",
        connectLatencyMs: 10,
        error: "gateway closed (1008): unauthorized",
        close: { code: 1008, reason: "unauthorized" },
        auth: { role: null, scopes: [], capability: "unknown" },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "http-liveness-unverified" }),
        expect.objectContaining({
          severity: "warning",
          requirement: "gateway-auth-unverified",
        }),
      ]),
    );
  });

  it("reports authenticated readiness only from a successful Gateway probe", async () => {
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, status: "live" }), { status: 200 }),
        ),
      probeGateway: vi.fn().mockResolvedValue({
        ok: true,
        gatewayReached: true,
        url: "wss://node.tail.ts.net:18789",
        connectLatencyMs: 10,
        error: null,
        close: null,
        auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "info", requirement: "gateway-authenticated" }),
      ]),
    );
  });

  it("does not call an anonymous successful probe authenticated", async () => {
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, status: "live" }), { status: 200 }),
        ),
      probeGateway: vi.fn().mockResolvedValue({
        ok: true,
        gatewayReached: true,
        url: "wss://node.tail.ts.net:18789",
        connectLatencyMs: 10,
        error: null,
        close: null,
        auth: { role: null, scopes: [], capability: "read_only" },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "gateway-auth-unverified" }),
      ]),
    );
    expect(result.some((finding) => finding.requirement === "gateway-authenticated")).toBe(false);
  });

  it("uses one outer deadline and returns a bounded unknown result", async () => {
    const probe = vi.fn(
      async (options: { signal?: AbortSignal }) =>
        await new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                ok: false,
                url: "wss://node.tail.ts.net:18789",
                connectLatencyMs: null,
                error: "aborted",
                close: null,
                auth: { role: null, scopes: [], capability: "unknown" },
                health: null,
                status: null,
                presence: null,
                configSnapshot: null,
              }),
            { once: true },
          );
        }),
    );

    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      timeoutMs: 10,
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, status: "live" }), { status: 200 }),
        ),
      probeGateway: probe,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "diagnostic-deadline" }),
      ]),
    );
  });

  it("enforces the outer deadline when an injected probe ignores cancellation", async () => {
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      timeoutMs: 10,
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, status: "live" }), { status: 200 }),
        ),
      probeGateway: vi.fn(async () => await new Promise(() => {})),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "diagnostic-deadline" }),
      ]),
    );
  }, 500);
});
