import type {
  HumanInterventionControlRequest,
  HumanInterventionInput,
  HumanInterventionResponse as HandoffResponse,
  HumanInterventionView,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { registerHumanInterventionEnglish } from "../../i18n/locales/en-human-intervention.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import {
  BrowserScreencastClient,
  type BrowserScreencastFrame,
} from "./browser-screencast-client.ts";
import type { HumanInterventionClient } from "./handoff-http-client.ts";
import {
  HumanBrowserPointerGesture,
  isSameHumanBrowserPoint,
  humanBrowserBeforeInput,
  humanBrowserTextInput,
  humanBrowserKeyInput,
} from "./human-intervention-input.ts";
import { humanInterventionStyles } from "./human-intervention-panel.styles.ts";

registerHumanInterventionEnglish();

type ScreencastResponse = { wsPath: string };

type ViewerConnection = { client: HumanInterventionClient; id: string };
type ControlSession = {
  connection: ViewerConnection;
  controllerId: string;
  generation: number;
  stream?: BrowserScreencastClient;
  renewTimer?: ReturnType<typeof setInterval>;
  renewing: boolean;
  inputOperation?: Promise<boolean>;
};

export class OpenClawHumanInterventionPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: HumanInterventionClient | null = null;
  @property({ type: Boolean }) available = false;
  @property() handoffId = "";
  @property({ type: Boolean }) autoClaim = false;
  @property({ attribute: false }) onDocumentClose?: () => void;

  @state() private handoff: HumanInterventionView | null = null;
  @state() private loading = true;
  @state() private busy = false;
  @state() private control: ControlSession | null = null;
  @state() private error = "";
  @state() private streamStatus: "idle" | "connecting" | "connected" = "idle";
  @state() private frameUrl = "";
  @state() private frameWidth = 0;
  @state() private frameHeight = 0;
  @state() private zoom = 1;

  private connection: ViewerConnection | null = null;
  private readonly pointerGesture = new HumanBrowserPointerGesture();
  @state() private armedTouch?: { x: number; y: number };
  private focusEpoch = 0;
  private framePageUrl = "";
  private get inputBusy(): boolean {
    return Boolean(this.control?.inputOperation);
  }
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && this.isController()) {
      void this.leave(false);
    }
  };

  static override styles = humanInterventionStyles;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.load();
  }

  override disconnectedCallback(): void {
    this.resetConnection();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available") || changed.has("handoffId")) {
      void this.load();
    }
  }

  private isCurrent(connection: ViewerConnection): boolean {
    return (
      this.isConnected &&
      this.available &&
      this.connection === connection &&
      this.client === connection.client &&
      this.handoffId === connection.id
    );
  }

  private ownsControl(session: ControlSession): boolean {
    return this.control === session && this.isCurrent(session.connection);
  }

  private resetConnection(): void {
    const session = this.control;
    this.connection = null;
    if (session) {
      this.stopControl(session);
      void this.releaseSession(session).catch(() => {});
    }
    this.busy = false;
    this.handoff = null;
  }

  private async load(): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    if (this.connection && this.isCurrent(this.connection)) {
      return;
    }
    this.resetConnection();
    const client = this.client;
    if (!client || !this.available || !this.handoffId) {
      return;
    }
    const connection = { client, id: this.handoffId };
    this.connection = connection;
    this.loading = true;
    this.error = "";
    try {
      const response = await client.request<HandoffResponse>("browser.handoff.get", {
        id: connection.id,
      });
      if (this.isCurrent(connection)) {
        this.handoff = response.handoff;
        if (this.autoClaim && ["waiting", "control"].includes(response.handoff.state)) {
          this.autoClaim = false;
          await this.claim();
        }
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.loading = false;
      }
    }
  }

  private retry(): void {
    this.resetConnection();
    void this.load();
  }

  private isController(): boolean {
    return this.control !== null && this.ownsControl(this.control);
  }

  private controlParams(session: ControlSession): HumanInterventionControlRequest {
    return {
      id: session.connection.id,
      controllerId: session.controllerId,
      generation: session.generation,
    };
  }

  private async claim(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.isCurrent(connection) || !this.handoff || this.busy) {
      return;
    }
    this.busy = true;
    this.error = "";
    // A delayed release from a retired claim must never own a later claim.
    const controllerId = generateUUID();
    let session: ControlSession | undefined;
    try {
      const response = await connection.client.request<HandoffResponse>("browser.handoff.claim", {
        id: connection.id,
        controllerId,
      });
      session = {
        connection,
        controllerId,
        generation: response.handoff.generation,
        renewing: false,
      };
      if (!this.isCurrent(connection)) {
        await this.releaseSession(session);
        return;
      }
      this.handoff = response.handoff;
      this.control = session;
      await this.startStream(session);
      if (this.ownsControl(session)) {
        const activeSession = session;
        session.renewTimer = setInterval(() => void this.renew(activeSession), 30_000);
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
      if (session && this.ownsControl(session)) {
        this.stopControl(session);
        await this.releaseSession(session).catch(() => {});
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.busy = false;
      }
    }
  }

  private async startStream(session: ControlSession): Promise<void> {
    this.streamStatus = "connecting";
    const response = await session.connection.client.request<ScreencastResponse>(
      "browser.handoff.browser",
      {
        ...this.controlParams(session),
        operation: "screencast",
        maxWidth: 2000,
        maxHeight: 2000,
      },
    );
    if (!this.ownsControl(session)) {
      return;
    }
    session.stream = new BrowserScreencastClient({
      gatewayUrl: session.connection.client.gatewayUrl,
      wsPath: response.wsPath,
      onReady: () => {
        if (this.ownsControl(session)) {
          this.streamStatus = "connected";
        }
      },
      onMeta: ({ url }) => {
        if (this.ownsControl(session) && this.framePageUrl && url !== this.framePageUrl) {
          this.clearFrame();
        }
      },
      onFrame: (frame) => {
        if (this.ownsControl(session)) {
          this.presentFrame(frame);
        }
      },
      onClose: () => {
        if (this.ownsControl(session)) {
          void this.leave(false);
        }
      },
    });
  }

  private presentFrame(frame: BrowserScreencastFrame): void {
    if (this.framePageUrl && frame.url !== this.framePageUrl) {
      this.clearFrame();
    }
    const previous = this.frameUrl;
    this.frameUrl = URL.createObjectURL(frame.blob);
    this.frameWidth = frame.cssWidth;
    this.frameHeight = frame.cssHeight;
    this.framePageUrl = frame.url;
    this.streamStatus = "connected";
    if (previous) {
      URL.revokeObjectURL(previous);
    }
  }

  private async renew(session: ControlSession): Promise<void> {
    if (!this.ownsControl(session) || session.renewing) {
      return;
    }
    session.renewing = true;
    try {
      const response = await session.connection.client.request<HandoffResponse>(
        "browser.handoff.renew",
        this.controlParams(session),
      );
      if (this.ownsControl(session)) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (this.ownsControl(session)) {
        this.error = formatUiError(error);
        this.stopControl(session);
        void this.releaseSession(session).catch(() => {});
      }
    } finally {
      session.renewing = false;
    }
  }

  // Retire local input and callbacks synchronously; remote release may await input.
  private stopControl(session: ControlSession): void {
    clearInterval(session.renewTimer);
    session.renewTimer = undefined;
    session.stream?.close();
    session.stream = undefined;
    if (this.control !== session) {
      return;
    }
    this.control = null;
    this.streamStatus = "idle";
    this.clearFrame();
  }

  private clearFrame(): void {
    if (this.frameUrl) {
      URL.revokeObjectURL(this.frameUrl);
    }
    this.frameUrl = "";
    this.frameWidth = 0;
    this.frameHeight = 0;
    this.framePageUrl = "";
    this.pointerGesture.clear();
    this.clearTouchKeyboard();
  }

  private async act(
    action: HumanInterventionInput,
    tap?: { touch: boolean; epoch: number },
  ): Promise<boolean> {
    const session = this.control;
    if (
      !session ||
      !this.ownsControl(session) ||
      this.busy ||
      session.inputOperation ||
      this.streamStatus !== "connected" ||
      !this.frameUrl
    ) {
      return false;
    }
    this.error = "";
    const operation = this.sendBrowserAction(session, action, tap);
    session.inputOperation = operation;
    this.requestUpdate();
    try {
      return await operation;
    } finally {
      session.inputOperation = undefined;
      if (this.ownsControl(session)) {
        this.requestUpdate();
      }
    }
  }

  private async sendBrowserAction(
    session: ControlSession,
    action: HumanInterventionInput,
    tap?: { touch: boolean; epoch: number },
  ): Promise<boolean> {
    try {
      const response = await session.connection.client.request<{ focusedEditable?: boolean }>(
        "browser.handoff.browser",
        {
          ...this.controlParams(session),
          operation: "act",
          action,
        },
      );
      if (
        this.ownsControl(session) &&
        action.kind === "clickCoords" &&
        tap?.epoch === this.focusEpoch
      ) {
        const keyboard = this.shadowRoot?.querySelector<HTMLTextAreaElement>(".canvas-keyboard");
        if (response.focusedEditable === true) {
          if (tap.touch) {
            this.armedTouch = { x: action.x, y: action.y };
          } else {
            keyboard?.focus({ preventScroll: true });
          }
        } else {
          this.clearTouchKeyboard();
          keyboard?.blur();
        }
      }
      return this.ownsControl(session);
    } catch (error) {
      if (this.ownsControl(session)) {
        this.error = formatUiError(error);
        if (action.kind === "clickCoords") {
          this.clearTouchKeyboard();
          this.shadowRoot?.querySelector<HTMLTextAreaElement>(".canvas-keyboard")?.blur();
        }
      }
      return false;
    }
  }

  private keyboardQueue: Promise<void> = Promise.resolve();
  @state() private keyboardPending = 0;

  private queueKeyboard(action: HumanInterventionInput | undefined): void {
    if (!action) {
      return;
    }
    const session = this.control;
    if (!session || this.busy) {
      return;
    }
    if (this.keyboardPending >= 128) {
      this.error = t("humanBrowser.linkRequestError");
      this.stopControl(session);
      void this.releaseSession(session).catch(() => {});
      return;
    }
    this.armedTouch = undefined;
    const epoch = this.focusEpoch;
    this.keyboardPending += 1;
    this.keyboardQueue = this.keyboardQueue.then(async () => {
      try {
        await session.inputOperation;
        if (epoch !== this.focusEpoch) {
          return;
        }
        if (this.ownsControl(session) && !(await this.act(action)) && this.ownsControl(session)) {
          // A failed chunk makes later text unsafe to replay into an unknown caret state.
          this.stopControl(session);
          await this.releaseSession(session).catch(() => {});
        }
      } finally {
        this.keyboardPending -= 1;
      }
    });
  }

  private clearTouchKeyboard(): void {
    this.armedTouch = undefined;
    this.focusEpoch += 1;
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.isController() || this.inputBusy || this.busy || this.keyboardPending > 0) {
      this.clearTouchKeyboard();
      return;
    }
    if (this.pointerGesture.down(event)) {
      this.clearTouchKeyboard();
    }
  }

  private cancelPointers(): void {
    this.pointerGesture.clear();
    this.clearTouchKeyboard();
  }

  private pointerUp(event: PointerEvent): void {
    const remote = { width: this.frameWidth, height: this.frameHeight };
    const action = this.pointerGesture.up(event, remote);
    if (!action) {
      return;
    }
    const touch = event.pointerType === "touch";
    const activate =
      action.kind === "clickCoords" &&
      touch &&
      this.armedTouch &&
      event.currentTarget instanceof HTMLImageElement &&
      isSameHumanBrowserPoint(
        this.armedTouch,
        action,
        event.currentTarget.getBoundingClientRect(),
        remote,
      );
    this.clearTouchKeyboard();
    if (activate && this.isController() && !this.inputBusy && !this.busy) {
      // Mobile keyboards require focus in the trusted tap handler, before an await.
      this.shadowRoot
        ?.querySelector<HTMLTextAreaElement>(".canvas-keyboard")
        ?.focus({ preventScroll: true });
    }
    if (action.kind === "press") {
      this.queueKeyboard(action);
    } else {
      void this.act(action, { touch: touch && !activate, epoch: this.focusEpoch });
    }
  }

  private async releaseSession(session: ControlSession): Promise<HandoffResponse> {
    await session.inputOperation;
    return await session.connection.client.request<HandoffResponse>(
      "browser.handoff.leave",
      this.controlParams(session),
    );
  }

  private async leave(showError = true): Promise<void> {
    const session = this.control;
    if (!session || !this.ownsControl(session)) {
      return;
    }
    this.busy = true;
    this.stopControl(session);
    try {
      const response = await this.releaseSession(session);
      if (this.isCurrent(session.connection)) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (showError && this.isCurrent(session.connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(session.connection)) {
        this.busy = false;
      }
    }
  }

  private async finish(
    method: "browser.handoff.complete" | "browser.handoff.cancel",
  ): Promise<void> {
    const connection = this.connection;
    const session = this.control;
    if (!connection || !this.isCurrent(connection) || !this.handoff || this.busy) {
      return;
    }
    if (method === "browser.handoff.complete" && !session) {
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      await session?.inputOperation;
      if (!this.isCurrent(connection)) {
        return;
      }
      if (session && !this.ownsControl(session)) {
        return;
      }
      const params =
        method === "browser.handoff.complete" && session
          ? this.controlParams(session)
          : { id: connection.id };
      const response = await connection.client.request<HandoffResponse>(method, params);
      if (!this.isCurrent(connection)) {
        return;
      }
      this.handoff = response.handoff;
      if (session) {
        this.stopControl(session);
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        if (session) {
          this.stopControl(session);
        }
        this.error = formatUiError(error);
        // Completion can durably revoke control before continuation admission fails.
        // Retire local authority even if the status refresh also fails.
        this.handoff = null;
        try {
          const response = await connection.client.request<HandoffResponse>("browser.handoff.get", {
            id: connection.id,
          });
          if (this.isCurrent(connection)) {
            this.handoff = response.handoff;
          }
        } catch {
          // The original failure remains visible with the normal retry action.
        }
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.busy = false;
      }
    }
  }

  private statusText(): string {
    if (this.handoff?.state === "resume_pending") {
      return t("humanBrowser.resumePending");
    }
    if (this.handoff?.state === "resumed") {
      return t("humanBrowser.continuationQueued");
    }
    if (this.handoff?.state === "cancelled") {
      return t("humanBrowser.cancelled");
    }
    if (this.handoff?.state === "expired") {
      return t("humanBrowser.expired");
    }
    if (this.handoff?.state === "control") {
      return this.isController() ? t("humanBrowser.control") : t("humanBrowser.controlElsewhere");
    }
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
            <button class="primary" data-retry @click=${() => this.retry()}>
              ${t("humanBrowser.retry")}
            </button>
          </div>
        </main>
      `;
    }
    const terminal = ["resume_pending", "resumed", "cancelled", "expired"].includes(
      this.handoff.state,
    );
    const controlling = this.isController();
    return html`
      <main class="page">
        <header>
          <h1>${t("humanBrowser.title")}</h1>
          ${this.handoff.hostname ? html`<div class="host">${this.handoff.hostname}</div>` : nothing}
          ${this.handoff.reason ? html`<p class="reason">${this.handoff.reason}</p>` : nothing}
          <p class="status" role="status">${this.statusText()}</p>
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        </header>

        ${
          controlling
            ? html`
                <div class="toolbar">
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
                <p class="hint">
                  ${t(this.armedTouch ? "humanBrowser.tapAgainToType" : "humanBrowser.gestureHint")}
                </p>
                <div
                  class="viewer"
                  @wheel=${(event: WheelEvent) => {
                    event.preventDefault();
                    this.clearTouchKeyboard();
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
                          @pointerdown=${(event: PointerEvent) => this.pointerDown(event)}
                          @pointerup=${(event: PointerEvent) => this.pointerUp(event)}
                          @pointermove=${(event: PointerEvent) => this.pointerGesture.move(event)}
                          @pointercancel=${() => this.cancelPointers()}
                        />`
                      : html`<div class="viewer-empty">${t("humanBrowser.browserLoading")}</div>`
                  }
                </div>
                <textarea
                  class="canvas-keyboard"
                  aria-label=${t("humanBrowser.typePlaceholder")}
                  ?disabled=${!controlling || this.streamStatus !== "connected" || !this.frameUrl || this.busy}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  @beforeinput=${(event: InputEvent) => this.queueKeyboard(humanBrowserBeforeInput(event))}
                  @input=${(event: InputEvent) => this.queueKeyboard(humanBrowserTextInput(event))}
                  @compositionend=${(event: CompositionEvent) => this.queueKeyboard(humanBrowserTextInput(event))}
                  @keydown=${(event: KeyboardEvent) => this.queueKeyboard(humanBrowserKeyInput(event))}
                ></textarea>
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
                          ?disabled=${this.busy || this.inputBusy || this.keyboardPending > 0}
                          @click=${() => void this.finish("browser.handoff.complete")}
                        >
                          ${t("humanBrowser.done")}
                        </button>
                      `
                    : nothing
                }
                <button
                  class="danger"
                  ?disabled=${this.busy || this.inputBusy || this.keyboardPending > 0}
                  @click=${() => void this.finish("browser.handoff.cancel")}
                >
                  ${t("humanBrowser.cancel")}
                </button>
              </div>`
            : html`<div class="actions">
                ${this.handoff.state === "resume_pending" ? html`<button data-refresh-status @click=${() => this.retry()}>${t("humanBrowser.refreshStatus")}</button>` : nothing}
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
