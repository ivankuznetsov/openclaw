import { t } from "../../i18n/index.ts";
import type { HandoffAccess } from "./handoff-access.ts";

/** App root for a scoped handoff; it never bootstraps the administrative Gateway client. */
export function createHandoffAppElement(access: HandoffAccess): CustomElementConstructor {
  return class extends HTMLElement {
    connectedCallback() {
      void import("./handoff-link-page.ts")
        .then(({ mountHandoffLinkPage }) => {
          if (this.isConnected) {
            mountHandoffLinkPage(this, access);
          }
        })
        .catch(() => {
          this.textContent = `${t("lazyView.errorTitle")}. ${t("lazyView.genericSubtitle")}`;
          const reload = document.createElement("button");
          reload.textContent = t("common.reload");
          reload.addEventListener("click", () => location.reload());
          this.append(reload);
          window.dispatchEvent(new Event("openclaw-control-ui-rendered"));
        });
    }
  };
}
