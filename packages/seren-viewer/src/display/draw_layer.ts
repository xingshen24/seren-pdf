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

import { BoxType, shadow } from "seren-common";
import { Outline } from "./editor/drawers/outline";
import { DOMSVGFactory } from "./svg_factory";

/**
 * Manage the SVGs drawn on top of the page canvas.
 * It's important to have them directly on top of the canvas because we want to
 * be able to use mix-blend-mode for some of them.
 */
export class DrawLayer {

  #parent: HTMLDivElement | null = null;

  #id = 0;

  #mapping = new Map<number, SVGElement>();

  #toUpdate = new Map<number, SVGElement>();

  protected pageIndex: number;

  constructor(pageIndex: number) {
    this.pageIndex = pageIndex;
  }

  setParent(parent: HTMLDivElement) {
    if (!this.#parent) {
      this.#parent = parent;
      return;
    }

    if (this.#parent !== parent) {
      if (this.#mapping.size > 0) {
        for (const root of this.#mapping.values()) {
          root.remove();
          parent.append(root);
        }
      }
      this.#parent = parent;
    }
  }

  static get _svgFactory() {
    return shadow(this, "_svgFactory", new DOMSVGFactory());
  }

  static #setBox(element: HTMLElement | SVGElement, { x = 0, y = 0, width = 1, height = 1 } = {}) {
    const { style } = element;
    style.top = `${100 * y}%`;
    style.left = `${100 * x}%`;
    style.width = `${100 * width}%`;
    style.height = `${100 * height}%`;
  }

  #createSVG(box: BoxType) {
    const svg = DrawLayer._svgFactory.create(1, 1, /* skipDimensions = */ true);
    this.#parent!.append(svg);
    svg.setAttribute("aria-hidden", "true");
    DrawLayer.#setBox(svg, box);

    return svg;
  }

  #createClipPath(defs: SVGElement, pathId: string) {
    const clipPath = DrawLayer._svgFactory.createElement("clipPath");
    defs.append(clipPath);
    const clipPathId = `clip_${pathId}`;
    clipPath.setAttribute("id", clipPathId);
    clipPath.setAttribute("clipPathUnits", "objectBoundingBox");
    const clipPathUse = DrawLayer._svgFactory.createElement("use");
    clipPath.append(clipPathUse);
    clipPathUse.setAttribute("href", `#${pathId}`);
    clipPathUse.classList.add("clip");

    return clipPathId;
  }

  draw(outlines: Outline, color: string, opacity: number, isPathUpdatable = false) {
    const id = this.#id++;
    const root = this.#createSVG(outlines.box!);
    root.classList.add(...outlines.classNamesForDrawing);

    const defs = DrawLayer._svgFactory.createElement("defs");
    root.append(defs);
    const path = DrawLayer._svgFactory.createElement("path");
    defs.append(path);
    const pathId = `path_p${this.pageIndex}_${id}`;
    path.setAttribute("id", pathId);
    path.setAttribute("d", outlines.toSVGPath());

    if (isPathUpdatable) {
      this.#toUpdate.set(id, path);
    }

    // Create the clipping path for the editor div.
    const clipPathId = this.#createClipPath(defs, pathId);

    const use = DrawLayer._svgFactory.createElement("use");
    root.append(use);
    root.setAttribute("fill", color);
    root.setAttribute("fill-opacity", `${opacity}`);
    use.setAttribute("href", `#${pathId}`);

    this.#mapping.set(id, root);

    return { id, clipPathId: `url(#${clipPathId})` };
  }

  drawOutline(outlines: Outline) {
    // We cannot draw the outline directly in the SVG for highlights because
    // it composes with its parent with mix-blend-mode: multiply.
    // But the outline has a different mix-blend-mode, so we need to draw it in
    // its own SVG.
    const id = this.#id++;
    const root = this.#createSVG(outlines.box!);
    root.classList.add(...outlines.classNamesForOutlining);
    const defs = DrawLayer._svgFactory.createElement("defs");
    root.append(defs);
    const path = DrawLayer._svgFactory.createElement("path");
    defs.append(path);
    const pathId = `path_p${this.pageIndex}_${id}`;
    path.setAttribute("id", pathId);
    path.setAttribute("d", outlines.toSVGPath());
    path.setAttribute("vector-effect", "non-scaling-stroke");

    let maskId;
    if (outlines.mustRemoveSelfIntersections) {
      const mask = DrawLayer._svgFactory.createElement("mask");
      defs.append(mask);
      maskId = `mask_p${this.pageIndex}_${id}`;
      mask.setAttribute("id", maskId);
      mask.setAttribute("maskUnits", "objectBoundingBox");
      const rect = DrawLayer._svgFactory.createElement("rect");
      mask.append(rect);
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", "white");
      const use = DrawLayer._svgFactory.createElement("use");
      mask.append(use);
      use.setAttribute("href", `#${pathId}`);
      use.setAttribute("stroke", "none");
      use.setAttribute("fill", "black");
      use.setAttribute("fill-rule", "nonzero");
      use.classList.add("mask");
    }

    const use1 = DrawLayer._svgFactory.createElement("use");
    root.append(use1);
    use1.setAttribute("href", `#${pathId}`);
    if (maskId) {
      use1.setAttribute("mask", `url(#${maskId})`);
    }
    const use2 = use1.cloneNode();
    root.append(use2);
    use1.classList.add("mainOutline");
    (<HTMLElement>use2).classList.add("secondaryOutline");

    this.#mapping.set(id, root);

    return id;
  }

  finalizeLine(id: number, line: Outline) {
    const path = this.#toUpdate.get(id)!;
    this.#toUpdate.delete(id);
    this.updateBox(id, line.box!);
    path.setAttribute("d", line.toSVGPath());
  }

  updateLine(id: number, line: Outline) {
    const root = this.#mapping.get(id)!;
    const defs = root.firstChild;
    const path = (<Element>defs).firstChild!;
    (<Element>path).setAttribute("d", line.toSVGPath());
  }

  updatePath(id: number, line: Outline) {
    this.#toUpdate.get(id)!.setAttribute("d", line.toSVGPath());
  }

  updateBox(id: number, box: BoxType) {
    DrawLayer.#setBox(this.#mapping.get(id)!, box);
  }

  show(id: number, visible: boolean) {
    this.#mapping.get(id)!.classList.toggle("hidden", !visible);
  }

  rotate(id: number, angle: number) {
    this.#mapping.get(id)!.setAttribute("data-main-rotation", angle.toString());
  }

  changeColor(id: number, color: string) {
    this.#mapping.get(id)!.setAttribute("fill", color);
  }

  changeOpacity(id: number, opacity: number) {
    this.#mapping.get(id)!.setAttribute("fill-opacity", opacity.toString());
  }

  addClass(id: number, className: string) {
    this.#mapping.get(id)!.classList.add(className);
  }

  removeClass(id: number, className: string) {
    this.#mapping.get(id)!.classList.remove(className);
  }

  getSVGRoot(id: number) {
    return this.#mapping.get(id);
  }

  remove(id: number) {
    this.#toUpdate.delete(id);
    if (this.#parent === null) {
      return;
    }
    this.#mapping.get(id)!.remove();
    this.#mapping.delete(id);
  }

  destroy() {
    this.#parent = null;
    for (const root of this.#mapping.values()) {
      root.remove();
    }
    this.#mapping.clear();
    this.#toUpdate.clear();
  }
}
