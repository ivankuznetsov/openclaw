import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { browserControlAuthoritySignal } from "../browser/control-authority.js";
import type { HumanInterventionCoordinator } from "./coordinator.js";
import type { HumanInterventionRecord } from "./service.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function readGeneration(params: Record<string, unknown>): number {
  const value = params.generation;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("generation must be a positive integer");
  }
  return value;
}

function present(record: HumanInterventionRecord) {
  return {
    id: record.id,
    state: record.state,
    generation: record.generation,
    reason: record.reason,
    hostname: record.hostname,
    expiresAtMs: record.expiresAtMs,
    browser: {
      target: record.browser.target,
      profile: record.browser.profile,
      targetId: record.browser.targetId,
    },
  };
}

function sanitizeAction(value: unknown, targetId: string): Record<string, unknown> {
  const action = asNullableRecord(value);
  if (!action) {
    throw new Error("action is required");
  }
  const kind = action.kind;
  if (kind === "clickCoords") {
    return {
      kind,
      targetId,
      x: action.x,
      y: action.y,
      ...(action.doubleClick === true ? { doubleClick: true } : {}),
    };
  }
  if (kind === "dragCoords") {
    return {
      kind,
      targetId,
      x: action.x,
      y: action.y,
      endX: action.endX,
      endY: action.endY,
    };
  }
  if (kind === "press") {
    return { kind, targetId, key: action.key };
  }
  if (kind === "type") {
    return {
      kind,
      targetId,
      selector: ":focus",
      text: action.text,
      ...(action.submit === true ? { submit: true } : {}),
    };
  }
  throw new Error("human browser input supports only clickCoords, dragCoords, press, and type");
}

function registerResultMethod(
  api: OpenClawPluginApi,
  method: string,
  scope: "operator.read" | "operator.write",
  assertFeatureEnabled: () => void,
  run: (params: Record<string, unknown>, assertCurrentAuthority: () => void) => Promise<unknown>,
): void {
  api.registerGatewayMethod(
    method,
    async ({ params, respond, hasCurrentClientAuthority }) => {
      try {
        assertFeatureEnabled();
        const assertCurrentAuthority = () => {
          if (hasCurrentClientAuthority?.() !== true) {
            throw new Error("Gateway client authority changed during human browser handoff");
          }
        };
        assertCurrentAuthority();
        respond(true, await run(params, assertCurrentAuthority));
      } catch (error) {
        const message = formatErrorMessage(error);
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      }
    },
    { scope },
  );
}

export function registerHumanInterventionGatewayMethods(params: {
  api: OpenClawPluginApi;
  coordinator: HumanInterventionCoordinator;
  forwardBrowserRequest: GatewayHandler;
  isEnabled?: () => boolean;
}): void {
  const { api, coordinator } = params;
  const assertFeatureEnabled = () => {
    if (params.isEnabled?.() === false) {
      throw new Error("Human browser intervention is disabled");
    }
  };
  registerResultMethod(
    api,
    "browser.handoff.get",
    "operator.read",
    assertFeatureEnabled,
    async (request) => ({
      handoff: present(await coordinator.get(readString(request, "id"))),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.claim",
    "operator.write",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(
        await coordinator.claim(
          {
            id: readString(request, "id"),
            controllerId: readString(request, "controllerId"),
          },
          guard,
        ),
      ),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.renew",
    "operator.write",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(
        await coordinator.renew(
          {
            id: readString(request, "id"),
            controllerId: readString(request, "controllerId"),
            generation: readGeneration(request),
          },
          guard,
        ),
      ),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.leave",
    "operator.write",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(
        await coordinator.leave(
          {
            id: readString(request, "id"),
            controllerId: readString(request, "controllerId"),
            generation: readGeneration(request),
          },
          guard,
        ),
      ),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.complete",
    "operator.write",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(
        await coordinator.complete(
          {
            id: readString(request, "id"),
            controllerId: readString(request, "controllerId"),
            generation: readGeneration(request),
          },
          guard,
        ),
      ),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.cancel",
    "operator.write",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(await coordinator.cancel(readString(request, "id"), guard)),
    }),
  );

  api.registerGatewayMethod(
    "browser.handoff.browser",
    async (request) => {
      try {
        assertFeatureEnabled();
        const id = readString(request.params, "id");
        const controllerId = readString(request.params, "controllerId");
        const generation = readGeneration(request.params);
        const operation = readString(request.params, "operation");
        await coordinator.runBrowserOperation(
          { id, controllerId, generation },
          async (record, authoritySignal) => {
            if (request.hasCurrentClientAuthority?.() !== true) {
              throw new Error("Gateway client authority changed during human browser input");
            }
            if (operation === "screencast") {
              await params.forwardBrowserRequest({
                ...request,
                params: {
                  target: "host",
                  method: "POST",
                  path: "/screencast",
                  query: { profile: record.browser.profile },
                  body: {
                    targetId: record.browser.targetId,
                    maxWidth: request.params.maxWidth,
                    maxHeight: request.params.maxHeight,
                    [browserControlAuthoritySignal]: authoritySignal,
                  },
                },
              });
              return;
            }
            if (operation === "act") {
              const action = sanitizeAction(request.params.action, record.browser.targetId);
              await params.forwardBrowserRequest({
                ...request,
                params: {
                  target: "host",
                  method: "POST",
                  path: "/act",
                  query: { profile: record.browser.profile },
                  body: {
                    ...action,
                    [browserControlAuthoritySignal]: authoritySignal,
                  },
                },
              });
              return;
            }
            throw new Error("operation must be screencast or act");
          },
        );
      } catch (error) {
        const message = formatErrorMessage(error);
        request.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      }
    },
    { scope: "operator.write" },
  );
}
