import type { HumanInterventionInput, HumanInterventionView } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { registerHumanInterventionEnglish } from "../../i18n/locales/en-human-intervention.ts";
import {
  humanBrowserBeforeInput,
  humanBrowserTextInput,
  humanBrowserKeyInput,
} from "./human-intervention-input.ts";

registerHumanInterventionEnglish();

type HumanInterventionPanelView = {
  available: boolean;
  loading: boolean;
  handoff: HumanInterventionView | null;
  error: string;
  controlling: boolean;
  statusText: string;
  zoom: number;
  armedTouch: boolean;
  frameUrl: string;
  busy: boolean;
  controlsDisabled: boolean;
  keyboardDisabled: boolean;
  retry: () => void;
  claim: () => void;
  complete: () => void;
  cancel: () => void;
  close: () => void;
  zoomBy: (delta: number) => void;
  pointerDown: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  cancelPointers: () => void;
  wheel: (event: WheelEvent) => void;
  queueKeyboard: (action: HumanInterventionInput | undefined) => void;
};

export function renderHumanIntervention(view: HumanInterventionPanelView) {
  if (!view.available) {
    return html`<main class="page"><p>${t("humanBrowser.unavailable")}</p></main>`;
  }
  if (view.loading) {
    return html`<main class="page"><p>${t("humanBrowser.loading")}</p></main>`;
  }
  if (!view.handoff) {
    return html`
      <main class="page">
        ${view.error ? html`<p class="error" role="alert">${view.error}</p>` : nothing}
        <div class="actions">
          <button class="primary" data-retry @click=${() => view.retry()}>
            ${t("humanBrowser.retry")}
          </button>
        </div>
      </main>
    `;
  }
  const terminal = ["resume_pending", "resumed", "cancelled", "expired"].includes(
    view.handoff.state,
  );
  const controlling = view.controlling;
  return html`
    <main class=${controlling ? "page page--control" : "page"}>
      <header>
        <div class="heading">
          <h1>${view.handoff.hostname || t("humanBrowser.title")}</h1>
          ${
            controlling
              ? html`<div class="toolbar">
                  <button
                    aria-label=${t("humanBrowser.zoomOut")}
                    @click=${() => {
                      view.zoomBy(-0.25);
                    }}
                  >
                    −
                  </button>
                  <button
                    aria-label=${t("humanBrowser.zoomIn")}
                    @click=${() => {
                      view.zoomBy(0.25);
                    }}
                  >
                    +
                  </button>
                </div>`
              : nothing
          }
        </div>
        ${
          controlling
            ? html`<details class="context">
                <summary>${t("humanBrowser.taskDetails")}</summary>
                ${view.handoff.reason ? html`<p class="reason">${view.handoff.reason}</p>` : nothing}
                <p class="status">${t("humanBrowser.linkExplanation")}</p>
              </details>`
            : view.handoff.reason
              ? html`<p class="reason">${view.handoff.reason}</p>`
              : nothing
        }
        <p class=${controlling ? "status sr-only" : "status"} role="status">${view.statusText}</p>
        ${view.error ? html`<p class="error" role="alert">${view.error}</p>` : nothing}
      </header>

      ${
        controlling
          ? html`
              <div
                class="viewer"
                @pointerdown=${(event: PointerEvent) => view.pointerDown(event)}
                @pointerup=${(event: PointerEvent) => view.pointerUp(event)}
                @pointermove=${(event: PointerEvent) => view.pointerMove(event)}
                @pointercancel=${() => view.cancelPointers()}
                @wheel=${(event: WheelEvent) => view.wheel(event)}
              >
                ${
                  view.frameUrl
                    ? html`<img
                        class="frame"
                        style=${`--human-browser-zoom: ${view.zoom}`}
                        src=${view.frameUrl}
                        alt=${view.handoff?.hostname || t("humanBrowser.title")}
                        draggable="false"
                      />`
                    : html`<div class="viewer-empty">${t("humanBrowser.browserLoading")}</div>`
                }
                ${view.armedTouch ? html`<p class="hint" role="status">${t("humanBrowser.tapAgainToType")}</p>` : nothing}
              </div>
              <textarea
                class="canvas-keyboard"
                aria-label=${t("humanBrowser.typePlaceholder")}
                ?disabled=${view.keyboardDisabled}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                @beforeinput=${(event: InputEvent) => view.queueKeyboard(humanBrowserBeforeInput(event))}
                @input=${(event: InputEvent) => view.queueKeyboard(humanBrowserTextInput(event))}
                @compositionend=${(event: CompositionEvent) => view.queueKeyboard(humanBrowserTextInput(event))}
                @keydown=${(event: KeyboardEvent) => view.queueKeyboard(humanBrowserKeyInput(event))}
              ></textarea>
            `
          : nothing
      }
      ${
        !terminal
          ? html`<div class="actions">
              ${view.handoff?.state === "waiting" || (view.handoff?.state === "control" && !controlling) ? html`<button class="primary" data-take-control ?disabled=${view.busy} @click=${() => view.claim()}>${t("humanBrowser.takeControl")}</button>` : nothing}
              ${
                controlling
                  ? html`
                      <button
                        class="primary"
                        data-complete
                        ?disabled=${view.controlsDisabled}
                        @click=${() => view.complete()}
                      >
                        ${t("humanBrowser.done")}
                      </button>
                    `
                  : nothing
              }
              <button
                class="danger"
                ?disabled=${view.controlsDisabled}
                @click=${() => view.cancel()}
              >
                ${t("humanBrowser.cancel")}
              </button>
            </div>`
          : html`<div class="actions">
              ${view.handoff.state === "resume_pending" ? html`<button data-refresh-status @click=${() => view.retry()}>${t("humanBrowser.refreshStatus")}</button>` : nothing}
              <button @click=${() => view.close()}>${t("common.close")}</button>
            </div>`
      }
    </main>
  `;
}
