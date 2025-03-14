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

import { BoxType } from "seren-common";
import { noContextMenu } from "../display_utils";
import { AltText } from "./alt_text";
import { ColorPicker } from "./color_picker";
import { AnnotationEditor } from "./editor";
import { AnnotationEditorUIManager } from "./tools";

export class EditorToolbar {

  static #l10nRemove: {
    freetext: "pdfjs-editor-remove-freetext-button",
    highlight: "pdfjs-editor-remove-highlight-button",
    ink: "pdfjs-editor-remove-ink-button",
    stamp: "pdfjs-editor-remove-stamp-button",
  } | null = null;

  #toolbar: HTMLDivElement | null = null;

  #colorPicker: ColorPicker | null = null;

  #editor: AnnotationEditor;

  #buttons: HTMLDivElement | null = null;

  constructor(editor: AnnotationEditor) {
    
    this.#editor = editor;

    EditorToolbar.#l10nRemove ||= Object.freeze({
      freetext: "pdfjs-editor-remove-freetext-button",
      highlight: "pdfjs-editor-remove-highlight-button",
      ink: "pdfjs-editor-remove-ink-button",
      stamp: "pdfjs-editor-remove-stamp-button",
    });
  }

  render() {
    const editToolbar = (this.#toolbar = document.createElement("div"));
    editToolbar.classList.add("editToolbar", "hidden");
    editToolbar.setAttribute("role", "toolbar");
    const signal = this.#editor._uiManager._signal!;
    editToolbar.addEventListener("contextmenu", noContextMenu, { signal });
    editToolbar.addEventListener("pointerdown", EditorToolbar.#pointerDown, {
      signal,
    });

    const buttons = (this.#buttons = document.createElement("div"));
    buttons.className = "buttons";
    editToolbar.append(buttons);

    const position = this.#editor.toolbarPosition;
    if (position) {
      const { style } = editToolbar;
      const x =
        this.#editor._uiManager.direction === "ltr"
          ? 1 - position[0]
          : position[0];
      style.insetInlineEnd = `${100 * x}%`;
      style.top = `calc(${100 * position[1]
        }% + var(--editor-toolbar-vert-offset))`;
    }

    this.#addDeleteButton();

    return editToolbar;
  }

  get div(): HTMLDivElement {
    return this.#toolbar!;
  }

  static #pointerDown(e: PointerEvent) {
    e.stopPropagation();
  }

  #focusIn(e: FocusEvent) {
    this.#editor._focusEventsAllowed = false;
    e.preventDefault();
    e.stopPropagation();
  }

  #focusOut(e: FocusEvent) {
    this.#editor._focusEventsAllowed = true;
    e.preventDefault();
    e.stopPropagation();
  }

  #addListenersToElement(element: HTMLButtonElement) {
    // If we're clicking on a button with the keyboard or with
    // the mouse, we don't want to trigger any focus events on
    // the editor.
    const signal = this.#editor._uiManager._signal!;
    element.addEventListener("focusin", this.#focusIn.bind(this), {
      capture: true,
      signal,
    });
    element.addEventListener("focusout", this.#focusOut.bind(this), {
      capture: true,
      signal,
    });
    element.addEventListener("contextmenu", noContextMenu, { signal });
  }

  hide() {
    this.#toolbar!.classList.add("hidden");
    this.#colorPicker?.hideDropdown();
  }

  show() {
    this.#toolbar!.classList.remove("hidden");
  }

  #addDeleteButton() {
    const { editorType, _uiManager } = this.#editor;

    const button = document.createElement("button");
    button.className = "delete";
    button.tabIndex = 0;
    button.setAttribute("data-l10n-id", (<Record<string, string>>EditorToolbar.#l10nRemove)[editorType]);
    this.#addListenersToElement(button);
    const signal = _uiManager._signal!;
    button.addEventListener("click", () => _uiManager.delete(), { signal });
    this.#buttons!.append(button);
  }

  get #divider() {
    const divider = document.createElement("div");
    divider.className = "divider";
    return divider;
  }

  async addAltText(altText: AltText) {
    const button = await altText.render();
    this.#addListenersToElement(button);
    this.#buttons!.prepend(button, this.#divider);
  }

  addColorPicker(colorPicker: ColorPicker) {
    this.#colorPicker = colorPicker;
    const button = colorPicker.renderButton();
    this.#addListenersToElement(button);
    this.#buttons!.prepend(button, this.#divider);
  }

  remove() {
    this.#toolbar!.remove();
    this.#colorPicker?.destroy();
    this.#colorPicker = null;
  }
}

export class HighlightToolbar {

  #buttons: HTMLDivElement | null = null;

  #toolbar: HTMLDivElement | null = null;

  #uiManager: AnnotationEditorUIManager;

  constructor(uiManager: AnnotationEditorUIManager) {
    this.#uiManager = uiManager;
  }

  #render() {
    const editToolbar = (this.#toolbar = document.createElement("div"));
    editToolbar.className = "editToolbar";
    editToolbar.setAttribute("role", "toolbar");
    editToolbar.addEventListener("contextmenu", noContextMenu, {
      signal: this.#uiManager._signal!,
    });

    const buttons = (this.#buttons = document.createElement("div"));
    buttons.className = "buttons";
    editToolbar.append(buttons);

    this.#addHighlightButton();

    return editToolbar;
  }

  #getLastPoint(boxes: BoxType[], isLTR: boolean) {
    let lastY = 0;
    let lastX = 0;
    for (const box of boxes) {
      const y = box.y + box.height;
      if (y < lastY) {
        continue;
      }
      const x = box.x + (isLTR ? box.width : 0);
      if (y > lastY) {
        lastX = x;
        lastY = y;
        continue;
      }
      if (isLTR) {
        if (x > lastX) {
          lastX = x;
        }
      } else if (x < lastX) {
        lastX = x;
      }
    }
    return [isLTR ? 1 - lastX : lastX, lastY];
  }

  show(parent: HTMLDivElement, boxes: BoxType[], isLTR: boolean) {
    const [x, y] = this.#getLastPoint(boxes, isLTR);
    const { style } = (this.#toolbar ||= this.#render());
    parent.append(this.#toolbar);
    style.insetInlineEnd = `${100 * x}%`;
    style.top = `calc(${100 * y}% + var(--editor-toolbar-vert-offset))`;
  }

  hide() {
    this.#toolbar!.remove();
  }

  #addHighlightButton() {
    const button = document.createElement("button");
    button.className = "highlightButton";
    button.tabIndex = 0;
    button.setAttribute("data-l10n-id", `pdfjs-highlight-floating-button1`);
    const span = document.createElement("span");
    button.append(span);
    span.className = "visuallyHidden";
    span.setAttribute("data-l10n-id", "pdfjs-highlight-floating-button-label");
    const signal = this.#uiManager._signal!;
    button.addEventListener("contextmenu", noContextMenu, { signal });
    button.addEventListener(
      "click",
      () => {
        this.#uiManager.highlightSelection("floating_button");
      },
      { signal }
    );
    this.#buttons!.append(button);
  }
}
