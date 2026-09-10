import { t } from "../../i18n/index.ts";
import type { HandoffAccess } from "./handoff-access.ts";

export interface HumanInterventionClient {
  readonly gatewayUrl: string;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

const actions = new Set(["get", "claim", "renew", "leave", "complete", "cancel", "browser"]);

export class HandoffHttpClient implements HumanInterventionClient {
  readonly gatewayUrl: string;
  constructor(private readonly access: HandoffAccess) {
    this.gatewayUrl = `${location.origin}${access.basePath ?? ""}`;
  }

  private async post<T>(body: Record<string, unknown>, authenticated: boolean): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        `${this.gatewayUrl}/browser/handoff/${encodeURIComponent(this.access.id)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authenticated ? { Authorization: `Bearer ${this.access.sessionToken}` } : {}),
          },
          body: JSON.stringify(body),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
      );
    } catch {
      throw new Error(t("humanBrowser.linkConnectionError"));
    }
    if (!response.ok) {
      // Do not reflect server errors, which may contain request credentials.
      throw new Error(
        t(
          response.status === 401 || response.status === 403 || response.status === 410
            ? "humanBrowser.linkExpired"
            : "humanBrowser.linkRequestError",
        ),
      );
    }
    try {
      // SAFETY: callers select the response type for this same-version, same-origin endpoint.
      return (await response.json()) as T;
    } catch {
      throw new Error(t("humanBrowser.linkRequestError"));
    }
  }

  async activate(): Promise<void> {
    if (!this.access.token && !this.access.sessionToken) {
      throw new Error(t("humanBrowser.linkExpired"));
    }
    if (this.access.storageUnavailable) {
      throw new Error(t("humanBrowser.linkStorageError"));
    }
    // Recover a lost redemption response using the secret persisted before POST.
    if (this.access.sessionToken) {
      try {
        await this.request("browser.handoff.get");
        return;
      } catch (error) {
        if (!this.access.token) {
          throw error;
        }
      }
    } else {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      this.access.sessionToken = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    }
    try {
      sessionStorage.setItem(
        this.access.storageKey,
        JSON.stringify({
          token: this.access.token,
          sessionToken: this.access.sessionToken,
        }),
      );
    } catch {
      throw new Error(t("humanBrowser.linkStorageError"));
    }
    await this.post(
      { action: "redeem", token: this.access.token, sessionToken: this.access.sessionToken },
      false,
    );
    delete this.access.token;
    sessionStorage.setItem(
      this.access.storageKey,
      JSON.stringify({ sessionToken: this.access.sessionToken }),
    );
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const action = method.startsWith("browser.handoff.")
      ? method.slice("browser.handoff.".length)
      : "";
    if (!actions.has(action) || !this.access.sessionToken) {
      throw new Error(t("humanBrowser.linkRequestError"));
    }
    const body = params && typeof params === "object" ? { ...params } : {};
    // The endpoint owns the handoff and controller identities.
    // SAFETY: body is a fresh object copied from object parameters or an empty object.
    const { id: _id, controllerId: _controllerId, ...operation } = body as Record<string, unknown>;
    const { action: input, ...fields } = operation;
    return this.post<T>({ ...fields, ...(input === undefined ? {} : { input }), action }, true);
  }
}
