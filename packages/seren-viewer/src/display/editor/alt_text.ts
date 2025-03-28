/* Copyright 2023 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { L10n } from "../../l10n/l10n";
import { noContextMenu } from "../display_utils";
import { AnnotationEditor } from "./editor";

interface AltTextData {
  alt: string | null,
  altText: string | null,
  decorative: boolean,
  guessedText: string | null,
  textWithDisclaimer: string | null,
  cancel: boolean | null,
}

export class AltText {

  #altText: string | null = null;

  #altTextDecorative = false;

  #altTextButton: HTMLButtonElement | null = null;

  #altTextButtonLabel: HTMLSpanElement | null = null;

  #altTextTooltip: HTMLSpanElement | null = null;

  #altTextTooltipTimeout: number | null = null;

  #altTextWasFromKeyBoard = false;

  #badge: HTMLDivElement | null = null;

  #editor: AnnotationEditor;

  #guessedText: string | null = null;

  #textWithDisclaimer: string | string[] | null = null;

  #useNewAltTextFlow = false;

  static #l10nNewButton: Record<string, string> | null = null;

  static _l10n: L10n | null = null;

  constructor(editor: AnnotationEditor) {
    this.#editor = editor;
    this.#useNewAltTextFlow = editor._uiManager.useNewAltTextFlow;
    AltText.#l10nNewButton ||= Object.freeze({
      added: "pdfjs-editor-new-alt-text-added-button",
      "added-label": "pdfjs-editor-new-alt-text-added-button-label",
      missing: "pdfjs-editor-new-alt-text-missing-button",
      "missing-label": "pdfjs-editor-new-alt-text-missing-button-label",
      review: "pdfjs-editor-new-alt-text-to-review-button",
      "review-label": "pdfjs-editor-new-alt-text-to-review-button-label",
    });
  }

  static initialize(l10n: L10n | null = null) {
    AltText._l10n ??= l10n;
  }

  async render() {
    const altText = (this.#altTextButton = document.createElement("button"));
    altText.className = "altText";
    altText.tabIndex = 0;

    const label = (this.#altTextButtonLabel = document.createElement("span"));
    altText.append(label);

    if (this.#useNewAltTextFlow) {
      altText.classList.add("new");
      altText.setAttribute("data-l10n-id", AltText.#l10nNewButton!.missing);
      label.setAttribute(
        "data-l10n-id",
        AltText.#l10nNewButton!["missing-label"]
      );
    } else {
      altText.setAttribute("data-l10n-id", "pdfjs-editor-alt-text-button");
      label.setAttribute("data-l10n-id", "pdfjs-editor-alt-text-button-label");
    }

    const signal = this.#editor._uiManager._signal!;
    altText.addEventListener("contextmenu", noContextMenu, { signal });
    altText.addEventListener("pointerdown", event => event.stopPropagation(), {
      signal,
    });

    const onClick = (event: UIEvent) => {
      event.preventDefault();
      this.#editor._uiManager.editAltText(this.#editor);
    };
    altText.addEventListener("click", onClick, { capture: true, signal });
    altText.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.target === altText && event.key === "Enter") {
          this.#altTextWasFromKeyBoard = true;
          onClick(event);
        }
      },
      { signal }
    );
    await this.#setState();

    return altText;
  }

  get #label() {
    return (
      (this.#altText && "added") ||
      (this.#altText === null && this.guessedText && "review") ||
      "missing"
    );
  }

  finish() {
    if (!this.#altTextButton) {
      return;
    }
    this.#altTextButton.focus({ focusVisible: this.#altTextWasFromKeyBoard });
    this.#altTextWasFromKeyBoard = false;
  }

  isEmpty() {
    if (this.#useNewAltTextFlow) {
      return this.#altText === null;
    }
    return !this.#altText && !this.#altTextDecorative;
  }

  hasData() {
    if (this.#useNewAltTextFlow) {
      return this.#altText !== null || !!this.#guessedText;
    }
    return this.isEmpty();
  }

  get guessedText() {
    return this.#guessedText;
  }

  async setGuessedText(guessedText: string | null) {
    if (this.#altText !== null) {
      // The user provided their own alt text, so we don't want to overwrite it.
      return;
    }
    this.#guessedText = guessedText;
    this.#textWithDisclaimer = await AltText._l10n!.get(
      "pdfjs-editor-new-alt-text-generated-alt-text-with-disclaimer",
      { generatedAltText: guessedText }
    );
    this.#setState();
  }

  toggleAltTextBadge(visibility = false) {
    if (!this.#useNewAltTextFlow || this.#altText) {
      this.#badge?.remove();
      this.#badge = null;
      return;
    }
    if (!this.#badge) {
      const badge = (this.#badge = document.createElement("div"));
      badge.className = "noAltTextBadge";
      this.#editor.div!.append(badge);
    }
    this.#badge.classList.toggle("hidden", !visibility);
  }

  serialize(isForCopying: boolean) {
    let altText: string | string[] | null = this.#altText;
    if (!isForCopying && this.#guessedText === altText) {
      altText = this.#textWithDisclaimer;
    }
    return {
      altText,
      decorative: this.#altTextDecorative,
      guessedText: this.#guessedText,
      textWithDisclaimer: this.#textWithDisclaimer,
    };
  }

  get data(): AltTextData {
    return {
      altText: this.#altText,
      decorative: this.#altTextDecorative,
      guessedText: null,
      textWithDisclaimer: null,
      cancel: null,
      alt: null
    };
  }

  /**
   * Set the alt text data.
   */
  set data({
    altText,
    decorative,
    guessedText,
    textWithDisclaimer,
    cancel = false,
  }: AltTextData) {
    if (guessedText) {
      this.#guessedText = guessedText;
      this.#textWithDisclaimer = textWithDisclaimer;
    }
    if (this.#altText === altText && this.#altTextDecorative === decorative) {
      return;
    }
    if (!cancel) {
      this.#altText = altText;
      this.#altTextDecorative = decorative;
    }
    this.#setState();
  }

  toggle(enabled = false) {
    if (!this.#altTextButton) {
      return;
    }
    if (!enabled && this.#altTextTooltipTimeout) {
      clearTimeout(this.#altTextTooltipTimeout);
      this.#altTextTooltipTimeout = null;
    }
    this.#altTextButton.disabled = !enabled;
  }

  destroy() {
    this.#altTextButton?.remove();
    this.#altTextButton = null;
    this.#altTextButtonLabel = null;
    this.#altTextTooltip = null;
    this.#badge?.remove();
    this.#badge = null;
  }

  async #setState() {
    const button = this.#altTextButton;
    if (!button) {
      return;
    }

    if (this.#useNewAltTextFlow) {
      button.classList.toggle("done", !!this.#altText);
      button.setAttribute("data-l10n-id", AltText.#l10nNewButton![this.#label]);

      this.#altTextButtonLabel?.setAttribute(
        "data-l10n-id",
        AltText.#l10nNewButton![`${this.#label}-label`]
      );
      if (!this.#altText) {
        this.#altTextTooltip?.remove();
        return;
      }
    } else {
      if (!this.#altText && !this.#altTextDecorative) {
        button.classList.remove("done");
        this.#altTextTooltip?.remove();
        return;
      }
      button.classList.add("done");
      button.setAttribute("data-l10n-id", "pdfjs-editor-alt-text-edit-button");
    }

    let tooltip = this.#altTextTooltip;
    if (!tooltip) {
      this.#altTextTooltip = tooltip = document.createElement("span");
      tooltip.className = "tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.id = `alt-text-tooltip-${this.#editor!.id}`;

      const DELAY_TO_SHOW_TOOLTIP = 100;
      const signal = this.#editor!._uiManager._signal!;
      signal.addEventListener("abort", () => {
        clearTimeout(this.#altTextTooltipTimeout!);
        this.#altTextTooltipTimeout = null;
      }, { once: true });
      button.addEventListener("mouseenter", () => {
        this.#altTextTooltipTimeout = setTimeout(() => {
          this.#altTextTooltipTimeout = null;
          this.#altTextTooltip!.classList.add("show");
        }, DELAY_TO_SHOW_TOOLTIP);
      }, { signal });
      button.addEventListener("mouseleave", () => {
        if (this.#altTextTooltipTimeout) {
          clearTimeout(this.#altTextTooltipTimeout);
          this.#altTextTooltipTimeout = null;
        }
        this.#altTextTooltip?.classList.remove("show");
      }, { signal });
    }
    if (this.#altTextDecorative) {
      tooltip.setAttribute(
        "data-l10n-id",
        "pdfjs-editor-alt-text-decorative-tooltip"
      );
    } else {
      tooltip.removeAttribute("data-l10n-id");
      tooltip.textContent = this.#altText;
    }

    if (!tooltip.parentNode) {
      button.append(tooltip);
    }

    const element = this.#editor.getImageForAltText();
    element?.setAttribute("aria-describedby", tooltip.id);
  }
}
