/* Copyright 2015 Mozilla Foundation
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

import {
  PlatformHelper,
  unreachable
} from "seren-common";
import { SVG_NS } from "./display_utils";

export abstract class BaseSVGFactory {

  constructor() {
    if (PlatformHelper.isTesting() && this.constructor === BaseSVGFactory) {
      unreachable("Cannot initialize BaseSVGFactory.");
    }
  }

  create(width: number, height: number, skipDimensions = false) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid SVG dimensions");
    }
    const svg = this._createSVG("svg:svg");
    svg.setAttribute("version", "1.1");

    if (!skipDimensions) {
      svg.setAttribute("width", `${width}px`);
      svg.setAttribute("height", `${height}px`);
    }

    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    return svg;
  }

  createElement(type: string) {
    if (typeof type !== "string") {
      throw new Error("Invalid SVG element type");
    }
    return this._createSVG(type);
  }

  protected abstract _createSVG(type: string): SVGElement;

}

export class DOMSVGFactory extends BaseSVGFactory {
  
  protected _createSVG(type: string): SVGElement {
    return document.createElementNS(SVG_NS, type);
  }
  
}
