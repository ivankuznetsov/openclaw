import type {
  HumanInterventionControlRequest,
  HumanInterventionInput,
  HumanInterventionResponse as HandoffResponse,
  HumanInterventionView,
} from "@openclaw/gateway-protocol";
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
  mergeHumanBrowserScroll,
  type HumanBrowserScroll,
  applyHumanBrowserViewport,
  humanBrowserWheel,
  isSameHumanBrowserPoint,
} from "./human-intervention-input.ts";
import { humanInterventionStyles } from "./human-intervention-panel.styles.ts";
import { renderHumanIntervention } from "./human-intervention-view.ts";

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
  @property({ attribute: false }) onCompleted?: () => void;

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
  private completedConnection: ViewerConnection | null = null;
  private readonly pointerGesture = new HumanBrowserPointerGesture();
  private pendingScroll?: { action: HumanBrowserScroll; session: ControlSession; epoch: number };
  private scrollEpoch = 0;
  private scrollPending = 0;
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
        this.notifyCompleted(connection);
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
      this.loading = false;
      await this.updateComplete;
      if (!this.ownsControl(session)) {
        return;
      }
      const viewer = this.shadowRoot?.querySelector<HTMLElement>(".viewer");
      const width = Math.min(8192, Math.floor(viewer?.clientWidth ?? 0));
      const height = Math.min(8192, Math.floor(viewer?.clientHeight ?? 0));
      if (width > 0 && height > 0) {
        await connection.client.request("browser.handoff.browser", {
          ...this.controlParams(session),
          operation: "act",
          action: { kind: "resize", width, height },
        });
      }
      if (!this.ownsControl(session)) {
        return;
      }
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
    this.clearScroll();
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
    this.pendingScroll = undefined;
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
    if (
      !this.isController() ||
      this.busy ||
      this.keyboardPending > this.scrollPending ||
      (this.inputBusy && this.scrollPending === 0)
    ) {
      this.clearTouchKeyboard();
      return;
    }
    if (this.pointerGesture.down(event)) {
      this.clearScroll();
      this.clearTouchKeyboard();
    }
  }

  private cancelPointers(): void {
    this.pointerGesture.clear();
    this.clearScroll();
    this.clearTouchKeyboard();
  }

  private pointerMove(event: PointerEvent): void {
    const viewer = event.currentTarget;
    const frame =
      viewer instanceof HTMLElement ? viewer.querySelector<HTMLImageElement>(".frame") : null;
    if (!frame || !(viewer instanceof HTMLElement)) {
      return;
    }
    const motion = this.pointerGesture.move(event, frame.getBoundingClientRect(), {
      width: this.frameWidth,
      height: this.frameHeight,
    });
    if (!motion) {
      return;
    }
    this.armedTouch = undefined;
    if (motion.kind === "scroll") {
      this.queueScroll(motion);
    } else {
      this.clearTouchKeyboard();
      this.clearScroll();
      this.zoom = applyHumanBrowserViewport(viewer, frame, motion, this.zoom);
    }
  }

  private clearScroll(): void {
    this.pendingScroll = undefined;
    this.scrollEpoch += 1;
  }

  private queueScroll(action: HumanBrowserScroll): void {
    const session = this.control;
    if (!session || !this.ownsControl(session) || this.busy) {
      return;
    }
    const pending = this.pendingScroll;
    if (pending?.session === session && pending.epoch === this.scrollEpoch) {
      pending.action = mergeHumanBrowserScroll(pending.action, action);
      return;
    }
    if (this.keyboardPending >= 128) {
      this.error = t("humanBrowser.linkRequestError");
      this.stopControl(session);
      void this.releaseSession(session).catch(() => {});
      return;
    }
    const batch = {
      action: mergeHumanBrowserScroll(undefined, action),
      session,
      epoch: this.scrollEpoch,
    };
    this.pendingScroll = batch;
    this.scrollPending += 1;
    this.keyboardPending += 1;
    this.keyboardQueue = this.keyboardQueue.then(async () => {
      try {
        if (this.pendingScroll === batch) {
          this.pendingScroll = undefined;
        }
        await session.inputOperation;
        if (!this.ownsControl(session) || batch.epoch !== this.scrollEpoch) {
          return;
        }
        if (!(await this.act(batch.action)) && this.ownsControl(session)) {
          this.stopControl(session);
          await this.releaseSession(session).catch(() => {});
        }
      } finally {
        this.scrollPending -= 1;
        this.keyboardPending -= 1;
      }
    });
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const viewer = event.currentTarget;
    const frame =
      viewer instanceof HTMLElement ? viewer.querySelector<HTMLImageElement>(".frame") : null;
    if (!frame) {
      return;
    }
    this.armedTouch = undefined;
    this.queueScroll(
      humanBrowserWheel(event, frame, { width: this.frameWidth, height: this.frameHeight }),
    );
  }

  private pointerUp(event: PointerEvent): void {
    const viewer = event.currentTarget;
    const frame =
      viewer instanceof HTMLElement ? viewer.querySelector<HTMLImageElement>(".frame") : null;
    if (!frame) {
      this.cancelPointers();
      return;
    }
    const remote = { width: this.frameWidth, height: this.frameHeight };
    const bounds = frame.getBoundingClientRect();
    const action = this.pointerGesture.up(event, bounds, remote);
    if (!action) {
      return;
    }
    if (action.kind === "scroll") {
      this.armedTouch = undefined;
      this.queueScroll(action);
      return;
    }
    const touch = event.pointerType === "touch";
    const activate =
      action.kind === "clickCoords" &&
      touch &&
      this.armedTouch &&
      isSameHumanBrowserPoint(this.armedTouch, action, bounds, remote);
    this.clearTouchKeyboard();
    if (activate && this.isController() && !this.inputBusy && !this.busy) {
      // Mobile keyboards require focus in the trusted tap handler, before an await.
      this.shadowRoot
        ?.querySelector<HTMLTextAreaElement>(".canvas-keyboard")
        ?.focus({ preventScroll: true });
    }
    void this.act(action, { touch: touch && !activate, epoch: this.focusEpoch });
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
      if (!this.isCurrent(connection) || (session && !this.ownsControl(session))) {
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
        this.notifyCompleted(connection);
      }
    }
  }

  private notifyCompleted(connection: ViewerConnection): void {
    // Both callers have revalidated this connection after their awaited work.
    if (this.handoff?.state === "resumed" && this.completedConnection !== connection) {
      this.completedConnection = connection;
      (this.onCompleted ?? this.onDocumentClose)?.();
    }
  }

  override render() {
    return renderHumanIntervention({
      available: this.available,
      loading: this.loading,
      handoff: this.handoff,
      error: this.error,
      controlling: this.isController(),
      zoom: this.zoom,
      armedTouch: Boolean(this.armedTouch),
      frameUrl: this.frameUrl,
      busy: this.busy,
      controlsDisabled: this.busy || this.inputBusy || this.keyboardPending > 0,
      keyboardDisabled: this.streamStatus !== "connected" || !this.frameUrl || this.busy,
      retry: () => this.retry(),
      claim: () => void this.claim(),
      complete: () => void this.finish("browser.handoff.complete"),
      cancel: () => void this.finish("browser.handoff.cancel"),
      close: this.onDocumentClose,
      zoomBy: (delta) => {
        this.zoom = Math.max(1, Math.min(3, this.zoom + delta));
      },
      pointerDown: (event) => this.pointerDown(event),
      pointerUp: (event) => this.pointerUp(event),
      pointerMove: (event) => this.pointerMove(event),
      cancelPointers: () => this.cancelPointers(),
      wheel: (event) => this.wheel(event),
      queueKeyboard: (action) => this.queueKeyboard(action),
    });
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
