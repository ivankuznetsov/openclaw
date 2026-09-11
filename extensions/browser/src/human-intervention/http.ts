import type { IncomingMessage, ServerResponse } from "node:http";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { browserControlAuthoritySignal } from "../browser/control-authority.js";
import type {
  BrowserDispatchRequest,
  BrowserDispatchResponse,
} from "../browser/routes/dispatcher.js";
import type { HumanInterventionCoordinator } from "./coordinator.js";
import { present, readGeneration, sanitizeAction } from "./gateway.js";
import type { MutationAuthorityGuard } from "./service.js";

type Options = {
  basePath?: string;
  coordinator: HumanInterventionCoordinator;
  isEnabled: () => boolean;
  publicOrigin: () => string;
  dispatchBrowser: (request: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>;
};

type StreamAuthority = { controlSignal: AbortSignal; controller: AbortController };

/** A separate capability boundary: these credentials never authenticate Gateway RPC. */
export function createHumanInterventionHttpHandler(options: Options) {
  const basePath = options.basePath ?? "";
  const streams = new Map<string, StreamAuthority>();
  let disposed = false;
  const configuredOrigin = () => {
    const url = new URL(options.publicOrigin());
    if (url.protocol !== "https:") {
      throw new Error("HTTPS required");
    }
    return url.origin;
  };
  const assertEnabled = () => {
    if (disposed || !options.isEnabled()) {
      throw new Error("Handoff disabled");
    }
  };
  const streamSignal = (
    id: string,
    guard: MutationAuthorityGuard,
    controlSignal: AbortSignal,
    origin: string,
  ) => {
    const existing = streams.get(id);
    if (existing?.controlSignal === controlSignal && !existing.controller.signal.aborted) {
      return existing.controller.signal;
    }
    existing?.controller.abort();
    const controller = new AbortController();
    const entry = { controlSignal, controller };
    streams.set(id, entry);
    let checking = false;
    const timer = setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void options.coordinator
        .get(id, guard)
        .then(() => {
          assertEnabled();
          if (configuredOrigin() !== origin) {
            throw new Error("Origin changed");
          }
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 1_000);
    timer.unref();
    const abort = () => controller.abort();
    controller.signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
        controlSignal.removeEventListener("abort", abort);
        if (streams.get(id) === entry) {
          streams.delete(id);
        }
      },
      { once: true },
    );
    controlSignal.addEventListener("abort", abort, { once: true });
    if (controlSignal.aborted) {
      controller.abort();
    }
    return controller.signal;
  };
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const scopedPath = path.startsWith(`${basePath}/browser/handoff/`)
      ? path.slice(basePath.length)
      : "";
    const match = /^\/browser\/handoff\/([A-Za-z0-9_-]{1,128})$/u.exec(scopedPath);
    const id = match?.[1];
    if (!id) {
      return false;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json");
    const send = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      send(405, { error: "Use the browser handoff viewer." });
      return true;
    }
    try {
      assertEnabled();
      const origin = configuredOrigin();
      if (
        req.headers.origin !== origin ||
        req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        throw new Error("Invalid request origin or content type");
      }
      const parsed = await readJsonBodyWithLimit(req, {
        maxBytes: 64 * 1024,
        timeoutMs: 10_000,
        destroyOnLimit: false,
      });
      if (!parsed.ok) {
        res.setHeader("Connection", "close");
        throw new Error("Invalid body");
      }
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        throw new Error("Invalid body");
      }
      // SAFETY: the checks above reject null, arrays, and non-object JSON values.
      const body = parsed.value as Record<string, unknown>;
      assertEnabled();
      if (body.action === "redeem") {
        if (typeof body.token !== "string" || typeof body.sessionToken !== "string") {
          throw new Error("Missing capability");
        }
        const result = await options.coordinator.service.redeemViewerLink(
          id,
          body.token,
          body.sessionToken,
          () => {
            assertEnabled();
            if (configuredOrigin() !== origin) {
              throw new Error("Origin changed");
            }
          },
        );
        assertEnabled();
        send(200, result);
        return true;
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization ?? "");
      const sessionToken = bearer?.[1];
      if (!sessionToken) {
        throw new Error("Missing capability");
      }
      const authority = await options.coordinator.service.viewerAuthority(
        id,
        sessionToken,
        body.action === "get",
      );
      const guard: MutationAuthorityGuard = (current, now) => {
        assertEnabled();
        if (configuredOrigin() !== origin) {
          throw new Error("Origin changed");
        }
        authority.assertCurrent(current, now);
      };
      const controllerId = () => {
        const nonce = body.controllerId;
        if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(nonce)) {
          throw new Error("Invalid controller claim");
        }
        // A claim nonce distinguishes retired mounts without granting authority
        // to impersonate a controller in another authenticated viewer session.
        return `${authority.controllerId}:${nonce}`;
      };
      const control = () => ({
        id,
        controllerId: controllerId(),
        generation: readGeneration(body),
      });
      let result: unknown;
      if (body.action === "get") {
        result = { handoff: present(await options.coordinator.get(id, guard)) };
      } else if (body.action === "claim") {
        result = {
          handoff: present(
            await options.coordinator.claim({ id, controllerId: controllerId() }, guard),
          ),
        };
      } else if (body.action === "renew" || body.action === "leave" || body.action === "complete") {
        result = { handoff: present(await options.coordinator[body.action](control(), guard)) };
      } else if (body.action === "cancel") {
        result = { handoff: present(await options.coordinator.cancel(id, guard)) };
      } else if (body.action === "browser") {
        result = await options.coordinator.runBrowserOperation(
          control(),
          async (record, controlAuthority) => {
            guard(record, Date.now());
            const operation = body.operation;
            if (operation !== "screencast" && operation !== "act") {
              throw new Error("Unsupported browser operation");
            }
            const input =
              operation === "act"
                ? sanitizeAction(body.input, record.browser.targetId)
                : {
                    targetId: record.browser.targetId,
                    maxWidth: body.maxWidth,
                    maxHeight: body.maxHeight,
                  };
            const signal = streamSignal(id, guard, controlAuthority, origin);
            signal.throwIfAborted();
            const response = await options.dispatchBrowser({
              method: "POST",
              path: operation === "act" ? "/act" : "/screencast",
              query: { profile: record.browser.profile },
              body: { ...input, [browserControlAuthoritySignal]: signal },
              signal,
              requester: {
                connId: `handoff:${id}:${record.generation}`,
                signal,
                isCurrent: () => !signal.aborted && options.isEnabled() && !disposed,
              },
            });
            if (response.status >= 400) {
              throw new Error("Browser operation failed");
            }
            if (operation === "screencast") {
              const responseBody = asNullableRecord(response.body);
              if (
                typeof responseBody?.wsPath !== "string" ||
                !responseBody.wsPath.startsWith("/browser/screencast?")
              ) {
                throw new Error("Invalid screencast path");
              }
              return { ...responseBody, wsPath: `${basePath}${responseBody.wsPath}` };
            }
            return response.body;
          },
          guard,
        );
      } else {
        throw new Error("Unsupported handoff operation");
      }
      assertEnabled();
      send(200, result);
    } catch {
      send(403, { error: "Browser handoff access is unavailable or expired." });
    }
    return true;
  };
  handler.dispose = () => {
    disposed = true;
    for (const entry of streams.values()) {
      entry.controller.abort();
    }
    streams.clear();
  };
  return handler;
}
