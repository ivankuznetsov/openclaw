import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  HumanInterventionControlRequest,
  HumanInterventionView,
} from "../../human-intervention-api.js";
import { browserControlAuthoritySignal } from "../browser/control-authority.js";
import type { HumanInterventionCoordinator } from "./coordinator.js";
import type { HumanInterventionRecord } from "./service.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

// A Gateway is one operator trust boundary. Channel sender IDs are provenance,
// not web credentials; observation and control both require administrator scope.
function createAuthorityGuard(
  assertFeatureEnabled: () => void,
  hasCurrentClientAuthority: (() => boolean) | undefined,
): () => void {
  return () => {
    assertFeatureEnabled();
    if (hasCurrentClientAuthority?.() !== true) {
      throw new Error("Gateway client authority changed during human browser handoff");
    }
  };
}

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

function readControlRequest(params: Record<string, unknown>): HumanInterventionControlRequest {
  return {
    id: readString(params, "id"),
    controllerId: readString(params, "controllerId"),
    generation: readGeneration(params),
  };
}

function present(record: HumanInterventionRecord): HumanInterventionView {
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
  assertFeatureEnabled: () => void,
  run: (params: Record<string, unknown>, assertCurrentAuthority: () => void) => Promise<unknown>,
): void {
  api.registerGatewayMethod(
    method,
    async ({ params, respond, hasCurrentClientAuthority }) => {
      try {
        const assertCurrentAuthority = createAuthorityGuard(
          assertFeatureEnabled,
          hasCurrentClientAuthority,
        );
        assertCurrentAuthority();
        const result = await run(params, assertCurrentAuthority);
        assertCurrentAuthority();
        respond(true, result);
      } catch (error) {
        const message = formatErrorMessage(error);
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      }
    },
    { scope: "operator.admin" },
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
  registerResultMethod(api, "browser.handoff.get", assertFeatureEnabled, async (request) => ({
    handoff: present(await coordinator.get(readString(request, "id"))),
  }));
  registerResultMethod(
    api,
    "browser.handoff.claim",
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
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(await coordinator.renew(readControlRequest(request), guard)),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.leave",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(await coordinator.leave(readControlRequest(request), guard)),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.complete",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(await coordinator.complete(readControlRequest(request), guard)),
    }),
  );
  registerResultMethod(
    api,
    "browser.handoff.cancel",
    assertFeatureEnabled,
    async (request, guard) => ({
      handoff: present(await coordinator.cancel(readString(request, "id"), guard)),
    }),
  );

  api.registerGatewayMethod(
    "browser.handoff.browser",
    async (request) => {
      try {
        const assertCurrentAuthority = createAuthorityGuard(
          assertFeatureEnabled,
          request.hasCurrentClientAuthority,
        );
        assertCurrentAuthority();
        const control = readControlRequest(request.params);
        const operation = readString(request.params, "operation");
        await coordinator.runBrowserOperation(control, async (record, authoritySignal) => {
          assertCurrentAuthority();
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
        });
      } catch (error) {
        const message = formatErrorMessage(error);
        request.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      }
    },
    { scope: "operator.admin" },
  );
}
