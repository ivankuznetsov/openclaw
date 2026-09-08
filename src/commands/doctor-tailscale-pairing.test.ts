import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayProbeResult } from "../gateway/probe.js";
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

  it("classifies an explicitly selected public URL as external ingress", () => {
    const result = findings({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "serve" },
      },
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirement: "external-serve-route" }),
        expect.objectContaining({ requirement: "external-managed-mode" }),
        expect.objectContaining({ requirement: "proxy-attribution" }),
      ]),
    );
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

  it("reports a Serve handler using the wrong backend scheme", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "off" } } },
      {
        routes: [{ ...externalRoute, target: "https://127.0.0.1:18789" }],
      },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", requirement: "serve-route-target" }),
      ]),
    );
  });

  it("accepts HTTPS forwarding for a TLS-enabled Gateway", () => {
    const result = findings(
      {
        gateway: {
          bind: "loopback",
          tailscale: { mode: "off" },
          tls: { enabled: true },
          trustedProxies: ["127.0.0.1"],
        },
      },
      {
        routes: [{ ...externalRoute, target: "https://127.0.0.1:18789" }],
      },
    );

    expect(result.some((entry) => entry.requirement === "serve-route-target")).toBe(false);
  });

  it("accepts a foreground managed route with its isolated backend port", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "serve" } } },
      {
        source: "gateway.tailscale.mode=serve",
        url: "wss://node.tail.ts.net",
        routes: [
          {
            ...externalRoute,
            management: "foreground",
            port: 443,
            target: "http://127.0.0.1:41234",
          },
        ],
      },
    );

    expect(result.some((entry) => entry.requirement === "serve-route-target")).toBe(false);
    expect(result.some((entry) => entry.requirement === "proxy-attribution")).toBe(false);
  });

  it("reports a managed endpoint without an active foreground claim", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "serve" } } },
      {
        url: "wss://node.tail.ts.net",
        source: "gateway.tailscale.mode=serve",
        routes: [{ ...externalRoute, port: 443 }],
      },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "managed-route-active" }),
      ]),
    );
  });

  it("recognizes a public URL that selects the managed foreground route", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "serve" } } },
      {
        url: "wss://node.tail.ts.net",
        routes: [
          {
            ...externalRoute,
            management: "foreground",
            port: 443,
            target: "http://127.0.0.1:41234",
          },
        ],
      },
    );

    expect(result.some((entry) => entry.requirement === "external-serve-route")).toBe(false);
    expect(result.some((entry) => entry.requirement === "serve-route-target")).toBe(false);
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

  it("flags an insecure Tailscale IPv6 WebSocket URL", () => {
    const result = findings(
      { gateway: { bind: "tailnet", tailscale: { mode: "off" } } },
      { url: "ws://[fd7a:115c:a1e0::9]:18789", source: "gateway.remote.url", routes: [] },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", requirement: "secure-mobile-url" }),
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

  it("reports browser origin policy when Serve status is unavailable", () => {
    const result = findings(
      {
        gateway: {
          tailscale: { mode: "serve" },
          controlUi: { allowedOrigins: ["https://other.example.com"] },
        },
      },
      {
        url: "wss://gateway.example.com:18789",
        source: "gateway.tailscale.mode=serve",
        status: "unavailable",
      },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirement: "serve-status-available" }),
        expect.objectContaining({ requirement: "control-ui-origin" }),
      ]),
    );
  });

  it("requires trust for the loopback family used by the Serve target", () => {
    const result = findings(
      {
        gateway: {
          bind: "loopback",
          tailscale: { mode: "off" },
          trustedProxies: ["127.0.0.1"],
        },
      },
      { routes: [{ ...externalRoute, target: "http://[::1]:18789" }] },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", requirement: "proxy-attribution" }),
      ]),
    );
  });

  it("does not call inferred token auth disabled for Funnel", () => {
    const result = findings(
      {
        gateway: {
          bind: "loopback",
          tailscale: { mode: "off" },
          trustedProxies: ["127.0.0.1"],
          auth: { token: "configured-token" },
        },
      },
      { routes: [{ ...externalRoute, funnel: true }] },
    );

    expect(result.some((entry) => entry.requirement === "external-funnel-auth")).toBe(false);
  });

  it("reports explicitly disabled auth for Funnel", () => {
    const result = findings(
      {
        gateway: {
          bind: "loopback",
          tailscale: { mode: "off" },
          trustedProxies: ["127.0.0.1"],
          auth: { mode: "none" },
        },
      },
      { routes: [{ ...externalRoute, funnel: true }] },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", requirement: "external-funnel-auth" }),
      ]),
    );
  });

  it("does not require ordinary-listener proxy trust for managed ingress", () => {
    const result = findings(
      { gateway: { bind: "loopback", tailscale: { mode: "serve" } } },
      {
        url: "wss://node.tail.ts.net",
        source: "gateway.tailscale.mode=serve",
        routes: [
          {
            ...externalRoute,
            management: "foreground",
            port: 443,
            target: "http://127.0.0.1:41234",
          },
        ],
      },
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

  it("limits the HTTP liveness response body", async () => {
    let bodyCancelled = false;
    let bodySent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (bodySent) {
          return;
        }
        bodySent = true;
        controller.enqueue(new TextEncoder().encode("x".repeat(5000)));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      timeoutMs: 1000,
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      probeGateway: vi.fn().mockResolvedValue({
        ok: false,
        url: "wss://node.tail.ts.net:18789",
        connectLatencyMs: null,
        error: "unreachable",
        close: null,
        auth: { role: null, scopes: [], capability: "unknown" },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });

    expect(bodyCancelled).toBe(true);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirement: "http-liveness-unverified" }),
      ]),
    );
  });

  it("aborts sibling network work after an unexpected probe failure", async () => {
    let fetchAborted = false;
    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              fetchAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    await expect(
      collectTailscalePairingHealthFindings({
        cfg,
        env: {},
        runCommandWithTimeout: serveRunner(),
        fetchFn,
        probeGateway: vi.fn().mockRejectedValue(new Error("probe failed")),
      }),
    ).rejects.toThrow("probe failed");
    expect(fetchAborted).toBe(true);
  });

  it("scopes the remote TLS fingerprint to its exact URL source", async () => {
    const probe = vi.fn().mockResolvedValue({
      ok: false,
      url: "wss://node.tail.ts.net:18789",
      connectLatencyMs: null,
      error: "unreachable",
      close: null,
      auth: { role: null, scopes: [], capability: "unknown" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const tlsFingerprint = "ab".repeat(32);

    await collectTailscalePairingHealthFindings({
      cfg: {
        gateway: {
          tailscale: { mode: "off" },
          remote: { url: "wss://node.tail.ts.net:18789", tlsFingerprint },
        },
      },
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn,
      probeGateway: probe,
    });
    expect(probe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: {
          gateway: {
            remote: { url: "wss://node.tail.ts.net:18789", tlsFingerprint },
          },
        },
      }),
    );

    await collectTailscalePairingHealthFindings({
      cfg: {
        gateway: {
          tailscale: { mode: "off" },
          remote: { url: "wss://remote.example", tlsFingerprint },
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: "wss://node.tail.ts.net:18789" } },
          },
        },
      },
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn,
      probeGateway: probe,
    });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ config: {} }));
  });

  it("redacts secrets and terminal controls from probe errors", async () => {
    const result = await collectTailscalePairingHealthFindings({
      cfg,
      env: {},
      runCommandWithTimeout: serveRunner(),
      fetchFn: vi.fn().mockResolvedValue(new Response("", { status: 503 })),
      probeGateway: vi.fn().mockResolvedValue({
        ok: false,
        url: "wss://node.tail.ts.net:18789",
        connectLatencyMs: null,
        error: "failed wss://user:password@node.tail.ts.net/path?token=secret-token\u001b[31m",
        close: null,
        auth: { role: null, scopes: [], capability: "unknown" },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      }),
    });
    const rendered = JSON.stringify(result);

    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("secret-token");
    expect(rendered).not.toContain("\\u001b");
  });

  it("uses one outer deadline and returns a bounded unknown result", async () => {
    const probe = vi.fn(
      async (options: { signal?: AbortSignal }): Promise<GatewayProbeResult> =>
        await new Promise<GatewayProbeResult>((resolve) => {
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
      probeGateway: vi.fn(
        async (): Promise<GatewayProbeResult> => await new Promise<GatewayProbeResult>(() => {}),
      ),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", requirement: "diagnostic-deadline" }),
      ]),
    );
  }, 500);
});
