/* Copyright 2020 Mozilla Foundation
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


/**
 * PLEASE NOTE: This file is currently imported in both the `../display/` and
 *              `../scripting_api/` folders, hence be EXTREMELY careful about
 *              introducing any dependencies here since that can lead to an
 *              unexpected/unnecessary size increase of the *built* files.
 */

function makeColorComp(n: number) {
  return Math.floor(Math.max(0, Math.min(1, n)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function scaleAndClamp(x: number) {
  return Math.max(0, Math.min(255, 255 * x));
}

type CYMK = [number, number, number, number];
export type RGBType = [number, number, number];

// PDF specifications section 10.3
export class ColorConverters {

  static executeHTML(method: keyof ColorConverters, colorArray: number[]): string {
    return (<Function>ColorConverters[method])(colorArray);
  }

  /* 需要将小rgb和大RGB区分开来 */
  static executeRgb(method: keyof ColorConverters, colorArray: number[]): [null] | RGBType {
    return (<Function>ColorConverters[method])(colorArray);
  }

  static CMYK_G([c, y, m, k]: CYMK) {
    return ["G", 1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k)];
  }

  static G_CMYK([g]: [number]) {
    return ["CMYK", 0, 0, 0, 1 - g];
  }

  static G_RGB([g]: [number]) {
    return ["RGB", g, g, g];
  }

  static G_rgb([g]: [number]) {
    g = scaleAndClamp(g);
    return [g, g, g];
  }

  static G_HTML([g]: [number]) {
    const G = makeColorComp(g);
    return `#${G}${G}${G}`;
  }

  static RGB_G([r, g, b]: RGBType) {
    return ["G", 0.3 * r + 0.59 * g + 0.11 * b];
  }

  static RGB_rgb(color: RGBType): RGBType {
    return <RGBType>color.map(scaleAndClamp);
  }

  static RGB_HTML(color: RGBType) {
    return `#${color.map(makeColorComp).join("")}`;
  }

  static T_HTML() {
    return "#00000000";
  }

  static T_rgb() {
    return [null];
  }

  static CMYK_RGB([c, y, m, k]: CYMK): [string, number, number, number] {
    return [
      "RGB",
      1 - Math.min(1, c + k),
      1 - Math.min(1, m + k),
      1 - Math.min(1, y + k),
    ];
  }

  static CMYK_rgb([c, y, m, k]: CYMK): RGBType {
    return [
      scaleAndClamp(1 - Math.min(1, c + k)),
      scaleAndClamp(1 - Math.min(1, m + k)),
      scaleAndClamp(1 - Math.min(1, y + k)),
    ];
  }

  static CMYK_HTML(components: CYMK) {
    // TODO 这里应该注意下，slice(1)的含义
    const rgb = <RGBType>this.CMYK_RGB(components).slice(1);
    return this.RGB_HTML(rgb);
  }

  static RGB_CMYK([r, g, b]: RGBType) {
    const c = 1 - r;
    const m = 1 - g;
    const y = 1 - b;
    const k = Math.min(c, m, y);
    return ["CMYK", c, m, y, k];
  }
}
