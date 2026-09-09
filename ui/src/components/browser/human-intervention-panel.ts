import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerHumanInterventionEnglish } from "../../i18n/locales/en-human-intervention.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import {
  BrowserScreencastClient,
  type BrowserScreencastFrame,
} from "./browser-screencast-client.ts";

registerHumanInterventionEnglish();

type HandoffState = "waiting" | "control" | "resume_pending" | "resumed" | "cancelled" | "expired";

type HumanInterventionView = {
  id: string;
  state: HandoffState;
  generation: number;
  reason?: string;
  hostname?: string;
  expiresAtMs?: number;
  browser?: { target: "host"; profile: string; targetId: string };
};

type HandoffResponse = { handoff: HumanInterventionView };
type ScreencastResponse = { wsPath: string };

export function resolveHumanBrowserPoint(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  remote: { width: number; height: number },
): { x: number; y: number } {
  const displayedWidth = Math.max(1, bounds.width);
  const displayedHeight = Math.max(1, bounds.height);
  return {
    x: Math.max(
      0,
      Math.min(remote.width, ((point.clientX - bounds.left) / displayedWidth) * remote.width),
    ),
    y: Math.max(
      0,
      Math.min(remote.height, ((point.clientY - bounds.top) / displayedHeight) * remote.height),
    ),
  };
}

export class OpenClawHumanInterventionPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property() handoffId = "";
  @property({ attribute: false }) onDocumentClose?: () => void;

  @state() private handoff: HumanInterventionView | null = null;
  @state() private loading = true;
  @state() private busy = false;
  @state() private inputBusy = false;
  @state() private error = "";
  @state() private streamStatus: "idle" | "connecting" | "connected" | "closed" = "idle";
  @state() private frameUrl = "";
  @state() private frameWidth = 0;
  @state() private frameHeight = 0;
  @state() private zoom = 1;
  @state() private textDraft = "";

  private controllerId = "";
  private stream: BrowserScreencastClient | null = null;
  private loadedKey = "";
  private renewTimer?: ReturnType<typeof setInterval>;
  private pointerStart?: { x: number; y: number; pointerId: number };
  private framePageUrl = "";
  private inputOperation: Promise<boolean> | null = null;
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && this.isController()) {
      void this.leave(false);
    }
  };

  static override styles = css`
    :host {
      display: block;
      min-height: 100dvh;
      color: var(--text);
      background: var(--bg);
    }

    * {
      box-sizing: border-box;
    }

    .page {
      width: min(100%, 920px);
      min-height: 100dvh;
      margin: 0 auto;
      padding: max(20px, var(--safe-area-top, 0px)) max(16px, var(--safe-area-right, 0px))
        max(24px, var(--safe-area-bottom, 0px)) max(16px, var(--safe-area-left, 0px));
      display: grid;
      align-content: start;
      gap: 16px;
    }

    header {
      display: grid;
      gap: 6px;
    }
    h1 {
      margin: 0;
      font-size: clamp(22px, 5vw, 32px);
      line-height: 1.15;
    }
    .host {
      font:
        600 14px/1.4 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      color: var(--muted);
    }
    .reason,
    .status,
    .error {
      margin: 0;
      line-height: 1.45;
    }
    .status {
      color: var(--muted);
    }
    .error {
      color: var(--danger);
    }

    .viewer {
      overflow: auto;
      overscroll-behavior: contain;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--bg-accent);
      min-height: min(62dvh, 620px);
      max-height: 68dvh;
      touch-action: pan-x pan-y;
    }

    .frame {
      display: block;
      width: calc(100% * var(--human-browser-zoom));
      height: auto;
      min-height: 240px;
      object-fit: contain;
      object-position: top left;
      user-select: none;
      -webkit-user-drag: none;
      touch-action: none;
    }

    .viewer-empty {
      min-height: min(62dvh, 620px);
      display: grid;
      place-items: center;
      padding: 24px;
      color: var(--text-strong);
      text-align: center;
    }

    .toolbar,
    .actions,
    .text-entry {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .toolbar {
      justify-content: flex-end;
    }
    .actions {
      padding-top: 4px;
    }
    .text-entry input {
      flex: 1 1 230px;
      min-width: 0;
    }

    button,
    input {
      min-height: 44px;
      border-radius: 10px;
      border: 1px solid var(--border);
      font: inherit;
    }
    button {
      padding: 0 14px;
      background: var(--bg-elevated);
      color: inherit;
      font-weight: 600;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-foreground);
    }
    button.danger {
      color: var(--danger);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    input {
      padding: 0 12px;
      background: var(--bg-elevated);
      color: inherit;
    }

    @media (max-width: 640px) {
      .page {
        padding-inline: 12px;
        gap: 12px;
      }
      .viewer,
      .viewer-empty {
        min-height: 54dvh;
        max-height: 60dvh;
      }
      .actions button {
        flex: 1 1 auto;
      }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.load();
  }

  override disconnectedCallback(): void {
    if (this.isController()) {
      void this.leave(false);
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopStream();
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available") || changed.has("handoffId")) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const client = this.client;
    if (!client || !this.available || !this.handoffId) {
      return;
    }
    const key = `${client.gatewayUrl}:${this.handoffId}`;
    if (key === this.loadedKey) {
      return;
    }
    this.loadedKey = key;
    this.handoff = null;
    this.loading = true;
    this.error = "";
    let failed = false;
    try {
      const response = await client.request<HandoffResponse>("browser.handoff.get", {
        id: this.handoffId,
      });
      if (this.loadedKey === key) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (this.loadedKey === key) {
        this.error = formatUiError(error);
        failed = true;
      }
    } finally {
      if (this.loadedKey === key) {
        this.loading = false;
        if (failed) {
          this.loadedKey = "";
        }
      }
    }
  }

  private retry(): void {
    this.loadedKey = "";
    void this.load();
  }

  private isController(): boolean {
    return this.handoff?.state === "control" && Boolean(this.controllerId);
  }

  private async claim(): Promise<void> {
    if (!this.client || !this.handoff || this.busy) return;
    this.busy = true;
    this.error = "";
    this.controllerId ||= this.loadOrCreateControllerId();
    try {
      const response = await this.client.request<HandoffResponse>("browser.handoff.claim", {
        id: this.handoff.id,
        controllerId: this.controllerId,
      });
      this.handoff = { ...this.handoff, ...response.handoff };
      await this.startStream();
      this.startRenewal();
    } catch (error) {
      this.error = formatUiError(error);
      if (this.isController()) {
        await this.leave(false);
      }
    } finally {
      this.busy = false;
    }
  }

  private async startStream(): Promise<void> {
    if (!this.client || !this.handoff || !this.isController()) return;
    this.stopStream();
    this.streamStatus = "connecting";
    const response = await this.client.request<ScreencastResponse>("browser.handoff.browser", {
      id: this.handoff.id,
      controllerId: this.controllerId,
      generation: this.handoff.generation,
      operation: "screencast",
      maxWidth: 2000,
      maxHeight: 2000,
    });
    this.stream = new BrowserScreencastClient({
      gatewayUrl: this.client.gatewayUrl,
      wsPath: response.wsPath,
      onReady: () => {
        this.streamStatus = "connected";
      },
      onMeta: ({ url }) => {
        if (this.framePageUrl && url !== this.framePageUrl) {
          this.clearFrame();
        }
      },
      onFrame: (frame) => this.presentFrame(frame),
      onClose: () => {
        this.stream = null;
        if (this.isController()) {
          this.streamStatus = "closed";
          void this.leave(false);
        }
      },
    });
  }

  private presentFrame(frame: BrowserScreencastFrame): void {
    const previous = this.frameUrl;
    this.frameUrl = URL.createObjectURL(frame.blob);
    this.frameWidth = frame.cssWidth;
    this.frameHeight = frame.cssHeight;
    this.framePageUrl = frame.url;
    this.streamStatus = "connected";
    if (previous) URL.revokeObjectURL(previous);
  }

  private startRenewal(): void {
    clearInterval(this.renewTimer);
    this.renewTimer = setInterval(() => void this.renew(), 30_000);
  }

  private async renew(): Promise<void> {
    if (!this.client || !this.handoff || !this.isController()) return;
    try {
      const response = await this.client.request<HandoffResponse>("browser.handoff.renew", {
        id: this.handoff.id,
        controllerId: this.controllerId,
        generation: this.handoff.generation,
      });
      this.handoff = { ...this.handoff, ...response.handoff };
    } catch (error) {
      this.stopStream();
      this.error = formatUiError(error);
    }
  }

  private stopStream(): void {
    clearInterval(this.renewTimer);
    this.renewTimer = undefined;
    this.stream?.close();
    this.stream = null;
    this.streamStatus = "idle";
    this.clearFrame();
  }

  private clearFrame(): void {
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl);
    this.frameUrl = "";
    this.frameWidth = 0;
    this.frameHeight = 0;
    this.framePageUrl = "";
  }

  private loadOrCreateControllerId(): string {
    const key = `openclaw.browserHandoff.controller:${this.handoffId}`;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const created = generateUUID();
      sessionStorage.setItem(key, created);
      return created;
    } catch {
      return generateUUID();
    }
  }

  private async act(action: Record<string, unknown>): Promise<boolean> {
    if (
      !this.client ||
      !this.handoff ||
      !this.isController() ||
      this.busy ||
      this.inputOperation ||
      this.streamStatus !== "connected" ||
      !this.frameUrl
    )
      return false;
    this.error = "";
    this.inputBusy = true;
    const operation = this.sendBrowserAction(action);
    this.inputOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.inputOperation === operation) {
        this.inputOperation = null;
        this.inputBusy = false;
      }
    }
  }

  private async sendBrowserAction(action: Record<string, unknown>): Promise<boolean> {
    if (!this.client || !this.handoff) return false;
    try {
      await this.client.request("browser.handoff.browser", {
        id: this.handoff.id,
        controllerId: this.controllerId,
        generation: this.handoff.generation,
        operation: "act",
        action,
      });
      return true;
    } catch (error) {
      this.error = formatUiError(error);
      return false;
    }
  }

  private async sendText(): Promise<void> {
    const text = this.textDraft;
    if (text && (await this.act({ kind: "type", text }))) {
      this.textDraft = "";
    }
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.isController() || this.inputBusy || this.busy) return;
    this.pointerStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  private pointerUp(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLImageElement)) return;
    const image = event.currentTarget;
    const start = this.pointerStart;
    this.pointerStart = undefined;
    if (!start || start.pointerId !== event.pointerId || !this.frameWidth || !this.frameHeight)
      return;
    const bounds = image.getBoundingClientRect();
    const from = resolveHumanBrowserPoint({ clientX: start.x, clientY: start.y }, bounds, {
      width: this.frameWidth,
      height: this.frameHeight,
    });
    const to = resolveHumanBrowserPoint(event, bounds, {
      width: this.frameWidth,
      height: this.frameHeight,
    });
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    void this.act(
      moved > 12
        ? { kind: "dragCoords", ...from, endX: to.x, endY: to.y }
        : { kind: "clickCoords", ...to },
    );
  }

  private async leave(showBusy = true): Promise<void> {
    if (!this.client || !this.handoff || !this.isController()) return;
    if (showBusy) this.busy = true;
    try {
      await this.inputOperation;
      if (!this.client || !this.handoff || !this.isController()) return;
      const response = await this.client.request<HandoffResponse>("browser.handoff.leave", {
        id: this.handoff.id,
        controllerId: this.controllerId,
        generation: this.handoff.generation,
      });
      this.handoff = { ...this.handoff, ...response.handoff };
      this.stopStream();
    } catch (error) {
      if (showBusy) this.error = formatUiError(error);
    } finally {
      if (showBusy) this.busy = false;
    }
  }

  private async finish(
    method: "browser.handoff.complete" | "browser.handoff.cancel",
  ): Promise<void> {
    if (!this.client || !this.handoff || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await this.inputOperation;
      if (!this.client || !this.handoff) return;
      const params =
        method === "browser.handoff.complete"
          ? {
              id: this.handoff.id,
              controllerId: this.controllerId,
              generation: this.handoff.generation,
            }
          : { id: this.handoff.id };
      const response = await this.client.request<HandoffResponse>(method, params);
      this.handoff = { ...this.handoff, ...response.handoff };
      this.stopStream();
    } catch (error) {
      this.error = formatUiError(error);
    } finally {
      this.busy = false;
    }
  }

  private statusText(): string {
    if (this.handoff?.state === "resumed" || this.handoff?.state === "resume_pending")
      return t("humanBrowser.resumed");
    if (this.handoff?.state === "cancelled") return t("humanBrowser.cancelled");
    if (this.handoff?.state === "expired") return t("humanBrowser.expired");
    if (this.handoff?.state === "control")
      return this.isController() ? t("humanBrowser.control") : t("humanBrowser.controlElsewhere");
    return t("humanBrowser.waiting");
  }

  override render() {
    if (!this.available) {
      return html`<main class="page"><p>${t("humanBrowser.unavailable")}</p></main>`;
    }
    if (this.loading) {
      return html`<main class="page"><p>${t("humanBrowser.loading")}</p></main>`;
    }
    if (!this.handoff) {
      return html`
        <main class="page">
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
          <div class="actions">
            <button class="primary" data-retry @click=${this.retry}>
              ${t("humanBrowser.retry")}
            </button>
          </div>
        </main>
      `;
    }
    const terminal =
      this.handoff &&
      ["resume_pending", "resumed", "cancelled", "expired"].includes(this.handoff.state);
    const controlling = this.isController();
    const browserReady =
      controlling &&
      this.streamStatus === "connected" &&
      Boolean(this.frameUrl) &&
      !this.inputBusy &&
      !this.busy;
    return html`
      <main class="page">
        <header>
          <h1>${t("humanBrowser.title")}</h1>
          ${this.handoff?.hostname ? html`<div class="host">${this.handoff.hostname}</div>` : nothing}
          ${this.handoff?.reason ? html`<p class="reason">${this.handoff.reason}</p>` : nothing}
          <p class="status" role="status">${this.statusText()}</p>
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        </header>

        ${
          controlling
            ? html`
                <div class="toolbar">
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "PageUp" })}
                  >
                    ${t("humanBrowser.scrollUp")}
                  </button>
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "PageDown" })}
                  >
                    ${t("humanBrowser.scrollDown")}
                  </button>
                  <button
                    aria-label=${t("humanBrowser.zoomOut")}
                    @click=${() => {
                      this.zoom = Math.max(1, this.zoom - 0.25);
                    }}
                  >
                    −
                  </button>
                  <button
                    aria-label=${t("humanBrowser.zoomIn")}
                    @click=${() => {
                      this.zoom = Math.min(3, this.zoom + 0.25);
                    }}
                  >
                    +
                  </button>
                </div>
                <div
                  class="viewer"
                  @wheel=${(event: WheelEvent) => {
                    event.preventDefault();
                    void this.act({
                      kind: "press",
                      key: event.deltaY >= 0 ? "PageDown" : "PageUp",
                    });
                  }}
                >
                  ${
                    this.frameUrl
                      ? html`<img
                          class="frame"
                          style=${`--human-browser-zoom: ${this.zoom}`}
                          src=${this.frameUrl}
                          alt=${this.handoff?.hostname ?? "Remote browser tab"}
                          draggable="false"
                          @pointerdown=${this.pointerDown}
                          @pointerup=${this.pointerUp}
                          @pointercancel=${() => {
                            this.pointerStart = undefined;
                          }}
                        />`
                      : html`<div class="viewer-empty">
                          ${this.streamStatus === "closed" ? t("humanBrowser.browserDisconnected") : t("humanBrowser.browserLoading")}
                        </div>`
                  }
                </div>
                <div class="text-entry">
                  <input
                    .value=${this.textDraft}
                    ?disabled=${!browserReady}
                    placeholder=${t("humanBrowser.typePlaceholder")}
                    @input=${(event: InputEvent) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.textDraft = event.currentTarget.value;
                      }
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter" && this.textDraft) {
                        event.preventDefault();
                        void this.sendText();
                      }
                    }}
                  />
                  <button
                    ?disabled=${!browserReady || !this.textDraft}
                    @click=${() => void this.sendText()}
                  >
                    ${t("humanBrowser.sendText")}
                  </button>
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "Enter" })}
                  >
                    ${t("humanBrowser.pressEnter")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          !terminal
            ? html`<div class="actions">
                ${this.handoff?.state === "waiting" || (this.handoff?.state === "control" && !controlling) ? html`<button class="primary" data-take-control ?disabled=${this.busy} @click=${() => void this.claim()}>${t("humanBrowser.takeControl")}</button>` : nothing}
                ${
                  controlling
                    ? html`
                        <button
                          class="primary"
                          data-complete
                          ?disabled=${this.busy || this.inputBusy}
                          @click=${() => void this.finish("browser.handoff.complete")}
                        >
                          ${t("humanBrowser.done")}
                        </button>
                        <button
                          data-leave
                          ?disabled=${this.busy || this.inputBusy}
                          @click=${() => void this.leave()}
                        >
                          ${t("humanBrowser.leave")}
                        </button>
                      `
                    : nothing
                }
                <button
                  class="danger"
                  ?disabled=${this.busy || this.inputBusy}
                  @click=${() => void this.finish("browser.handoff.cancel")}
                >
                  ${t("humanBrowser.cancel")}
                </button>
              </div>`
            : html`<div class="actions">
                <button @click=${() => this.onDocumentClose?.()}>${t("common.close")}</button>
              </div>`
        }
      </main>
    `;
  }
}

if (!customElements.get("openclaw-human-intervention-panel")) {
  customElements.define("openclaw-human-intervention-panel", OpenClawHumanInterventionPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-human-intervention-panel": OpenClawHumanInterventionPanel;
  }
}
