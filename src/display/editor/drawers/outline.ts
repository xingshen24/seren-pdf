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

import { unreachable } from "../../../shared/util";

class Outline {
  /**
   * @returns {string} The SVG path of the outline.
   */
  toSVGPath() {
    unreachable("Abstract method `toSVGPath` must be implemented.");
  }

  /**
   * @type {Object|null} The bounding box of the outline.
   */
  // eslint-disable-next-line getter-return
  get box() : { x: number; y: number; width: number; height: number; lastPoint: number[]; } | null {
    throw new Error("抽象函数需要被继承者实现");
  }

  serialize(_bbox, _rotation) {
    unreachable("Abstract method `serialize` must be implemented.");
  }

  // eslint-disable-next-line getter-return
  get classNamesForDrawing() {
    unreachable("Abstract getter `classNamesForDrawing` must be implemented.");
  }

  // eslint-disable-next-line getter-return
  get classNamesForOutlining() {
    unreachable(
      "Abstract getter `classNamesForOutlining` must be implemented."
    );
  }

  get mustRemoveSelfIntersections() {
    return false;
  }
}

export { Outline };
