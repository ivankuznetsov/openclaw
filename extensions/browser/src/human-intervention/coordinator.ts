import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { HumanInterventionProfileGate } from "./profile-gate.js";
import {
  HumanInterventionService,
  type HumanInterventionBrowser,
  type HumanInterventionRecord,
} from "./service.js";

type ScheduleContinuation = OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"];

type CoordinatorOptions = {
  publicUrl: string | (() => string);
  basePath?: string | (() => string | undefined);
  scheduleContinuation: ScheduleContinuation;
  now?: () => number;
};

type ControlAuthority = {
  controllerId: string;
  generation: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

export type HumanInterventionRequestInput = {
  profile: string;
  targetId: string;
  reason: string;
  hostname?: string;
  resolveHostname?: () => Promise<string>;
};

export type HumanInterventionRequestResult = {
  record: HumanInterventionRecord;
  launchUrl: string;
};

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  return trimmed ? `/${trimmed}` : "";
}

function normalizeBoundedText(value: string, fallback: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return (normalized || fallback).slice(0, maxLength);
}

export function buildHumanInterventionLaunchUrl(params: {
  publicUrl: string;
  basePath?: string;
  id: string;
}): string {
  const publicUrl = new URL(params.publicUrl);
  if (publicUrl.protocol !== "https:") {
    throw new Error("gateway.publicOrigin must use HTTPS for human browser handoff");
  }
  publicUrl.pathname = `${publicUrl.pathname.replace(/\/+$/u, "")}${normalizeBasePath(params.basePath)}/focus/browser/${encodeURIComponent(params.id)}`;
  publicUrl.search = "";
  publicUrl.hash = "";
  return publicUrl.toString();
}

export class HumanInterventionCoordinator {
  private readonly continuationRuns = new Map<string, Promise<HumanInterventionRecord>>();
  private readonly handoffTails = new Map<string, Promise<void>>();
  private readonly controlAuthorities = new Map<string, ControlAuthority>();
  private readonly now: () => number;

  constructor(
    readonly service: HumanInterventionService,
    private readonly options: CoordinatorOptions,
    private readonly profileGate = new HumanInterventionProfileGate(service),
  ) {
    this.now = options.now ?? Date.now;
  }

  async request(
    context: OpenClawPluginToolContext,
    input: HumanInterventionRequestInput,
  ): Promise<HumanInterventionRequestResult> {
    if (context.senderIsOwner !== true || !context.requesterSenderId) {
      throw new Error("Human browser handoff requires an owner-authorized conversation");
    }
    const channel = context.deliveryContext?.channel ?? context.messageChannel;
    const to = context.deliveryContext?.to ?? context.nativeChannelId;
    if (!channel || !to || !context.sessionKey || !context.agentId) {
      throw new Error("Human browser handoff requires an active delivery route and session");
    }
    const agentId = context.agentId;
    const sessionKey = context.sessionKey;
    const requesterSenderId = context.requesterSenderId;
    const accountId = context.deliveryContext?.accountId ?? context.agentAccountId ?? "default";
    const browser = { target: "host", profile: input.profile, targetId: input.targetId } as const;
    const record = await this.profileGate.reserve(browser, async () => {
      const hostname = input.resolveHostname ? await input.resolveHostname() : input.hostname;
      return await this.service.request({
        agentId,
        sessionKey,
        owner: { channel, accountId, senderId: requesterSenderId },
        origin: {
          channel,
          accountId,
          to,
          ...(context.deliveryContext?.threadId !== undefined
            ? { threadId: String(context.deliveryContext.threadId) }
            : {}),
        },
        browser,
        reason: normalizeBoundedText(input.reason, "Human verification required", 240),
        hostname: normalizeBoundedText(hostname ?? "", "this site", 253),
      });
    });
    const publicUrl =
      typeof this.options.publicUrl === "function"
        ? this.options.publicUrl()
        : this.options.publicUrl;
    const basePath =
      typeof this.options.basePath === "function" ? this.options.basePath() : this.options.basePath;
    try {
      const launchUrl = buildHumanInterventionLaunchUrl({ publicUrl, basePath, id: record.id });
      return { record, launchUrl };
    } catch (error) {
      await this.service.cancel(record.id);
      throw error;
    }
  }

  async get(id: string): Promise<HumanInterventionRecord> {
    return await this.service.get(id);
  }

  async claim(
    input: { id: string; controllerId: string },
    assertCurrentAuthority?: () => void,
  ): Promise<HumanInterventionRecord> {
    return await this.runExclusive(input.id, async () => {
      const record = await this.service.claim(input, assertCurrentAuthority);
      this.syncControlAuthority(record);
      return record;
    });
  }

  async renew(
    input: {
      id: string;
      controllerId: string;
      generation: number;
    },
    assertCurrentAuthority?: () => void,
  ): Promise<HumanInterventionRecord> {
    return await this.runExclusive(input.id, async () => {
      const record = await this.service.renew(input, assertCurrentAuthority);
      this.syncControlAuthority(record);
      return record;
    });
  }

  async runBrowserOperation<T>(
    input: { id: string; controllerId: string; generation: number },
    operation: (record: HumanInterventionRecord, authoritySignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return await this.runExclusive(input.id, async () => {
      const record = await this.service.authorizeControl(input);
      return await operation(record, this.syncControlAuthority(record));
    });
  }

  async leave(
    input: {
      id: string;
      controllerId: string;
      generation: number;
    },
    assertCurrentAuthority?: () => void,
  ): Promise<HumanInterventionRecord> {
    return await this.runExclusive(input.id, async () => {
      const record = await this.service.leave(input, assertCurrentAuthority);
      this.revokeControlAuthority(input.id);
      return record;
    });
  }

  async cancel(id: string, assertCurrentAuthority?: () => void): Promise<HumanInterventionRecord> {
    return await this.runExclusive(id, async () => {
      const record = await this.service.cancel(id, assertCurrentAuthority);
      this.revokeControlAuthority(id);
      return record;
    });
  }

  async complete(
    input: {
      id: string;
      controllerId: string;
      generation: number;
    },
    assertCurrentAuthority?: () => void,
  ): Promise<HumanInterventionRecord> {
    const completed = await this.runExclusive(input.id, async () => {
      const record = await this.service.complete(input, assertCurrentAuthority);
      this.revokeControlAuthority(input.id);
      return record;
    });
    if (completed.state === "resumed") {
      return completed;
    }
    return await this.schedule(completed);
  }

  async reconcile(): Promise<void> {
    for (const record of await this.service.listResumePending()) {
      await this.schedule(record);
    }
  }

  async beginAutomation(browser: HumanInterventionBrowser): Promise<() => Promise<void>> {
    return await this.profileGate.beginAutomation(browser);
  }

  stop(): void {
    for (const id of this.controlAuthorities.keys()) {
      this.revokeControlAuthority(id);
    }
  }

  private async runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.handoffTails.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.handoffTails.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.handoffTails.get(id) === current) {
        this.handoffTails.delete(id);
      }
    }
  }

  private syncControlAuthority(record: HumanInterventionRecord): AbortSignal {
    if (
      record.state !== "control" ||
      !record.controllerId ||
      record.controllerLeaseExpiresAtMs === undefined
    ) {
      throw new Error("Human browser handoff has no active control authority");
    }
    let authority = this.controlAuthorities.get(record.id);
    if (
      authority &&
      (authority.controllerId !== record.controllerId || authority.generation !== record.generation)
    ) {
      this.revokeControlAuthority(record.id);
      authority = undefined;
    }
    if (!authority) {
      authority = {
        controllerId: record.controllerId,
        generation: record.generation,
        controller: new AbortController(),
      };
      this.controlAuthorities.set(record.id, authority);
    }
    if (authority.timer) {
      clearTimeout(authority.timer);
    }
    const deadline = Math.min(record.expiresAtMs, record.controllerLeaseExpiresAtMs);
    const delayMs = Math.max(0, deadline - this.now());
    if (delayMs === 0) {
      this.revokeControlAuthority(record.id);
      return authority.controller.signal;
    }
    const current = authority;
    authority.timer = setTimeout(() => {
      if (this.controlAuthorities.get(record.id) === current) {
        this.revokeControlAuthority(record.id);
      }
    }, delayMs);
    authority.timer.unref();
    return authority.controller.signal;
  }

  private revokeControlAuthority(id: string): void {
    const authority = this.controlAuthorities.get(id);
    if (!authority) {
      return;
    }
    this.controlAuthorities.delete(id);
    if (authority.timer) {
      clearTimeout(authority.timer);
    }
    authority.controller.abort();
  }

  private async schedule(record: HumanInterventionRecord): Promise<HumanInterventionRecord> {
    const existing = this.continuationRuns.get(record.id);
    if (existing) {
      return await existing;
    }
    const run = this.scheduleOnce(record).finally(() => {
      this.continuationRuns.delete(record.id);
    });
    this.continuationRuns.set(record.id, run);
    return await run;
  }

  private async scheduleOnce(record: HumanInterventionRecord): Promise<HumanInterventionRecord> {
    const continuationId = record.continuationId;
    if (!continuationId) {
      throw new Error("Human browser handoff is missing its continuation id");
    }
    const handle = await this.options.scheduleContinuation({
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      message: [
        `Human browser intervention ${record.id} is complete.`,
        `Inspect browser profile ${record.browser.profile}, tab ${record.browser.targetId}, and verify the blocking step has cleared before continuing the original task.`,
        "Report the result in this conversation.",
      ].join(" "),
      at: record.completedAtMs ?? record.updatedAtMs,
      deleteAfterRun: false,
      deliveryMode: "announce",
      deliveryTarget: record.origin,
      idempotencyKey: continuationId,
      name: continuationId,
      tag: `browser-handoff-${continuationId}`,
    });
    if (!handle) {
      throw new Error("Could not schedule the human browser handoff continuation");
    }
    return await this.service.markResumed({ id: record.id, continuationId });
  }
}
