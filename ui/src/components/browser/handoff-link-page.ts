import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { registerHumanInterventionEnglish } from "../../i18n/locales/en-human-intervention.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import type { HandoffAccess } from "./handoff-access.ts";
import { HandoffHttpClient } from "./handoff-http-client.ts";
import { humanInterventionStyles } from "./human-intervention-panel.styles.ts";
import "./human-intervention-panel.ts";

registerHumanInterventionEnglish();

class HandoffLinkPage extends OpenClawLitElement {
  @property({ attribute: false }) access!: HandoffAccess;
  @state() private client: HandoffHttpClient | null = null;
  @state() private busy = false;
  @state() private error = "";
  static override styles = [
    humanInterventionStyles,
    css`
      :host {
        height: 100dvh;
        overflow-y: auto;
      }
    `,
  ];

  protected override firstUpdated(): void {
    window.dispatchEvent(new Event("openclaw-control-ui-rendered"));
  }

  private async takeControl() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      const client = new HandoffHttpClient(this.access);
      await client.activate();
      if (this.isConnected) {
        this.client = client;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : t("humanBrowser.linkRequestError");
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (this.client) {
      return html`<openclaw-human-intervention-panel
        .client=${this.client}
        .handoffId=${this.access.id}
        .available=${true}
        .autoClaim=${true}
      ></openclaw-human-intervention-panel>`;
    }
    return html`<main class="page">
      <h1>${t("humanBrowser.title")}</h1>
      <p>${t("humanBrowser.linkExplanation")}</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      <button class="primary" ?disabled=${this.busy} @click=${() => void this.takeControl()}>
        ${t(this.busy ? "humanBrowser.loading" : "humanBrowser.takeControl")}
      </button>
    </main>`;
  }
}
customElements.define("openclaw-handoff-link-page", HandoffLinkPage);

export function mountHandoffLinkPage(host: HTMLElement, access: HandoffAccess): void {
  // SAFETY: this module registers HandoffLinkPage under this exact custom-element name above.
  const page = document.createElement("openclaw-handoff-link-page") as HandoffLinkPage;
  page.access = access;
  host.replaceChildren(page);
}
