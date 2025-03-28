/* Copyright 2012 Mozilla Foundation
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
  bytesToString,
  FONT_IDENTITY_MATRIX,
  FontRenderOps,
  FormatError,
  unreachable,
  warn,
  PlatformHelper,
  TransformType, isNumberArray
} from "seren-common";
import { CFFDict, CFFDictKey, CFFFDSelect, CFFParser, CFFTopDict } from "./cff_parser";
import { getGlyphsUnicode } from "./glyphlist";
import { StandardEncoding } from "../../tables/encodings";
import { Stream } from "../../stream/stream";
import { Font } from "./fonts";
import { EvaluatorProperties } from "../../parser/evaluator/evaluator";

// TODO: use DataView and its methods.

function getUint32(data: Uint8Array, offset: number) {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function getUint16(data: Uint8Array, offset: number) {
  return (data[offset] << 8) | data[offset + 1];
}

function getInt16(data: Uint8Array, offset: number) {
  return ((data[offset] << 24) | (data[offset + 1] << 16)) >> 16;
}

function getInt8(data: Uint8Array, offset: number) {
  return (data[offset] << 24) >> 24;
}

function getFloat214(data: Uint8Array, offset: number) {
  return getInt16(data, offset) / 16384;
}

function getSubroutineBias(subrs: string | any[]) {
  const numSubrs = subrs.length;
  let bias = 32768;
  if (numSubrs < 1240) {
    bias = 107;
  } else if (numSubrs < 33900) {
    bias = 1131;
  }
  return bias;
}

type CMapRange = { start?: number, end?: number, idDelta?: number, ids?: number[] };

function parseCmap(data: Uint8Array, start: number, _end: number) {
  const offset =
    getUint16(data, start + 2) === 1
      ? getUint32(data, start + 8)
      : getUint32(data, start + 16);
  const format = getUint16(data, start + offset);
  let ranges: CMapRange[], p, i;
  if (format === 4) {
    getUint16(data, start + offset + 2); // length
    const segCount = getUint16(data, start + offset + 6) >> 1;
    p = start + offset + 14;
    ranges = [];
    for (i = 0; i < segCount; i++, p += 2) {
      ranges[i] = { end: getUint16(data, p) };
    }
    p += 2;
    for (i = 0; i < segCount; i++, p += 2) {
      ranges[i].start = getUint16(data, p);
    }
    for (i = 0; i < segCount; i++, p += 2) {
      ranges[i].idDelta = getUint16(data, p);
    }
    for (i = 0; i < segCount; i++, p += 2) {
      let idOffset = getUint16(data, p);
      if (idOffset === 0) {
        continue;
      }
      ranges[i].ids = [];
      for (let j = 0, jj = ranges[i].end! - ranges[i].start! + 1; j < jj; j++) {
        ranges[i].ids![j] = getUint16(data, p + idOffset);
        idOffset += 2;
      }
    }
    return ranges;
  } else if (format === 12) {
    const groups = getUint32(data, start + offset + 12);
    p = start + offset + 16;
    ranges = [];
    for (i = 0; i < groups; i++) {
      start = getUint32(data, p);
      ranges.push({
        start,
        end: getUint32(data, p + 4),
        idDelta: getUint32(data, p + 8) - start,
      });
      p += 12;
    }
    return ranges;
  }
  throw new FormatError(`unsupported cmap: ${format}`);
}

type CFFInfo = {
  glyphs: (Uint8Array | number[])[];
  subrs: (Uint8Array | number[])[] | undefined;
  gsubrs: (Uint8Array | number[])[] | undefined;
  isCFFCIDFont: boolean;
  fdSelect: CFFFDSelect | null;
  fdArray: CFFDict[];
}

function defaultEvaluatorProperties(): EvaluatorProperties {
  const prop: EvaluatorProperties = {
    privateData: null,
    glyphNames: [],
    seacMap: null,
    ascentScaled: false,
    builtInEncoding: [],
    type: "",
    name: "",
    subtype: null,
    loadedName: null,
    systemFontInfo: null,
    widths: {},
    defaultWidth: 0,
    isSimulatedFlags: false,
    flags: 0,
    firstChar: 0,
    lastChar: 0,
    toUnicode: null,
    xHeight: 0,
    capHeight: 0,
    italicAngle: 0,
    isType3Font: false,
    composite: false,
    cidSystemInfo: null,
    defaultEncoding: null,
    file: null,
    hasIncludedToUnicodeMap: false,
    dict: null,
    hasEncoding: false,
    baseEncodingName: null,
    differences: [],
    cidToGidMap: [],
    fallbackToUnicode: [],
    cMap: null,
    vertical: false,
    cidEncoding: "",
    defaultVMetrics: [],
    vmetrics: [],
    length1: null,
    length2: null,
    length3: null,
    fixedPitch: false,
    fontMatrix: null,
    bbox: null,
    ascent: null,
    descent: null,
    cssFontInfo: null,
    scaleFactors: null
  }
  return prop
}

function parseCff(
  data: Uint8Array<ArrayBuffer>,
  start: number,
  end: number,
  seacAnalysisEnabled: boolean
): CFFInfo {
  // 这个变量根本就没有用到过
  const properties = defaultEvaluatorProperties();
  const parser = new CFFParser(
    new Stream(data, start, end - start), properties, seacAnalysisEnabled
  );
  const cff = parser.parse();
  return {
    glyphs: cff.charStrings!.objects,
    subrs: cff.topDict!.privateDict?.subrsIndex?.objects,
    gsubrs: cff.globalSubrIndex?.objects,
    isCFFCIDFont: cff.isCIDFont,
    fdSelect: cff.fdSelect,
    fdArray: cff.fdArray,
  };
}

function parseGlyfTable(glyf: Uint8Array, loca: Uint8Array, isGlyphLocationsLong: number): Uint8Array[] {
  let itemSize, itemDecode;
  if (isGlyphLocationsLong) {
    itemSize = 4;
    itemDecode = getUint32;
  } else {
    itemSize = 2;
    itemDecode = (data: Uint8Array, offset: number) => 2 * getUint16(data, offset);
  }
  const glyphs = [];
  let startOffset = itemDecode(loca, 0);
  for (let j = itemSize; j < loca.length; j += itemSize) {
    const endOffset = itemDecode(loca, j);
    glyphs.push(glyf.subarray(startOffset, endOffset));
    startOffset = endOffset;
  }
  return glyphs;
}

function lookupCmap(ranges: CMapRange[], unicode: string): { charCode: number, glyphId: number } {
  const code = unicode.codePointAt(0)!;
  let gid = 0,
    l = 0,
    r = ranges.length - 1;
  while (l < r) {
    const c = (l + r + 1) >> 1;
    if (code < ranges[c].start!) {
      r = c - 1;
    } else {
      l = c;
    }
  }
  if (ranges[l].start! <= code && code <= ranges[l].end!) {
    gid =
      (ranges[l].idDelta! +
        (ranges[l].ids ? ranges[l].ids![code - ranges[l].start!] : code)) &
      0xffff;
  }
  return {
    charCode: code,
    glyphId: gid,
  };
}

function compileGlyf(code: Uint8Array, cmds: Commands, font: CompiledFont) {

  function moveTo(x: number, y: number) {
    cmds.add(FontRenderOps.MOVE_TO, [x, y]);
  }

  function lineTo(x: number, y: number) {
    cmds.add(FontRenderOps.LINE_TO, [x, y]);
  }

  function quadraticCurveTo(xa: number, ya: number, x: number, y: number) {
    cmds.add(FontRenderOps.QUADRATIC_CURVE_TO, [xa, ya, x, y]);
  }

  let i = 0;
  const numberOfContours = getInt16(code, i);
  let flags;
  let x = 0, y = 0;
  i += 10;
  if (numberOfContours < 0) {
    // composite glyph
    do {
      flags = getUint16(code, i);
      const glyphIndex = getUint16(code, i + 2);
      i += 4;
      let arg1, arg2;
      if (flags & 0x01) {
        if (flags & 0x02) {
          arg1 = getInt16(code, i);
          arg2 = getInt16(code, i + 2);
        } else {
          arg1 = getUint16(code, i);
          arg2 = getUint16(code, i + 2);
        }
        i += 4;
      } else if (flags & 0x02) {
        arg1 = getInt8(code, i++);
        arg2 = getInt8(code, i++);
      } else {
        arg1 = code[i++];
        arg2 = code[i++];
      }
      if (flags & 0x02) {
        x = arg1;
        y = arg2;
      } else {
        x = 0;
        y = 0;
      }
      let scaleX = 1,
        scaleY = 1,
        scale01 = 0,
        scale10 = 0;
      if (flags & 0x08) {
        scaleX = scaleY = getFloat214(code, i);
        i += 2;
      } else if (flags & 0x40) {
        scaleX = getFloat214(code, i);
        scaleY = getFloat214(code, i + 2);
        i += 4;
      } else if (flags & 0x80) {
        scaleX = getFloat214(code, i);
        scale01 = getFloat214(code, i + 2);
        scale10 = getFloat214(code, i + 4);
        scaleY = getFloat214(code, i + 6);
        i += 8;
      }
      const subglyph = font.glyphs[glyphIndex];
      if (subglyph) {
        // TODO: the transform should be applied only if there is a scale:
        // https://github.com/freetype/freetype/blob/edd4fedc5427cf1cf1f4b045e53ff91eb282e9d4/src/truetype/ttgload.c#L1205
        cmds.add(FontRenderOps.SAVE);
        cmds.add(FontRenderOps.TRANSFORM, [
          scaleX,
          scale01,
          scale10,
          scaleY,
          x,
          y,
        ]);

        if (!(flags & 0x02)) {
          // TODO: we must use arg1 and arg2 to make something similar to:
          // https://github.com/freetype/freetype/blob/edd4fedc5427cf1cf1f4b045e53ff91eb282e9d4/src/truetype/ttgload.c#L1209
        }
        compileGlyf(subglyph, cmds, font);
        cmds.add(FontRenderOps.RESTORE);
      }
    } while (flags & 0x20);
  } else {
    // simple glyph
    const endPtsOfContours = [];
    let j, jj;
    for (j = 0; j < numberOfContours; j++) {
      endPtsOfContours.push(getUint16(code, i));
      i += 2;
    }
    const instructionLength = getUint16(code, i);
    i += 2 + instructionLength; // skipping the instructions
    const numberOfPoints = endPtsOfContours.at(-1)! + 1;
    const points: { flags: number, x?: number, y?: number }[] = [];
    while (points.length < numberOfPoints) {
      flags = code[i++];
      let repeat = 1;
      if (flags & 0x08) {
        repeat += code[i++];
      }
      while (repeat-- > 0) {
        points.push({ flags });
      }
    }
    for (j = 0; j < numberOfPoints; j++) {
      switch (points[j].flags & 0x12) {
        case 0x00:
          x += getInt16(code, i);
          i += 2;
          break;
        case 0x02:
          x -= code[i++];
          break;
        case 0x12:
          x += code[i++];
          break;
      }
      points[j].x = x;
    }
    for (j = 0; j < numberOfPoints; j++) {
      switch (points[j].flags & 0x24) {
        case 0x00:
          y += getInt16(code, i);
          i += 2;
          break;
        case 0x04:
          y -= code[i++];
          break;
        case 0x24:
          y += code[i++];
          break;
      }
      points[j].y = y;
    }

    let startPoint = 0;
    for (i = 0; i < numberOfContours; i++) {
      const endPoint = endPtsOfContours[i];
      // contours might have implicit points, which is located in the middle
      // between two neighboring off-curve points
      const contour = points.slice(startPoint, endPoint + 1);
      if (contour[0].flags & 1) {
        contour.push(contour[0]); // using start point at the contour end
      } else if (contour.at(-1)!.flags & 1) {
        // first is off-curve point, trying to use one from the end
        contour.unshift(contour.at(-1)!);
      } else {
        // start and end are off-curve points, creating implicit one
        const p = {
          flags: 1,
          x: (contour[0].x! + contour.at(-1)!.x!) / 2,
          y: (contour[0].y! + contour.at(-1)!.y!) / 2,
        };
        contour.unshift(p);
        contour.push(p);
      }
      moveTo(contour[0].x!, contour[0].y!);
      for (j = 1, jj = contour.length; j < jj; j++) {
        if (contour[j].flags & 1) {
          lineTo(contour[j].x!, contour[j].y!);
        } else if (contour[j + 1].flags & 1) {
          quadraticCurveTo(
            contour[j].x!,
            contour[j].y!,
            contour[j + 1].x!,
            contour[j + 1].y!
          );
          j++;
        } else {
          quadraticCurveTo(
            contour[j].x!,
            contour[j].y!,
            (contour[j].x! + contour[j + 1].x!) / 2,
            (contour[j].y! + contour[j + 1].y!) / 2
          );
        }
      }
      startPoint = endPoint + 1;
    }
  }
}

function compileCharString(charStringCode: number[] | Uint8Array, cmds: Commands, font: Type2Compiled, glyphId: number) {
  function moveTo(x: number, y: number) {
    cmds.add(FontRenderOps.MOVE_TO, [x, y]);
  }
  function lineTo(x: number, y: number) {
    cmds.add(FontRenderOps.LINE_TO, [x, y]);
  }
  function bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    cmds.add(FontRenderOps.BEZIER_CURVE_TO, [x1, y1, x2, y2, x, y]);
  }

  const stack = <number[]>[];

  let x = 0, y = 0;
  let stems = 0;

  function parse(code: number[] | Uint8Array) {
    let i = 0;
    while (i < code.length) {
      let stackClean = false;
      let v = code[i++];
      let xa, xb, ya, yb, y1, y2, y3, n, subrCode;
      switch (v) {
        case 1: // hstem
          stems += stack.length >> 1;
          stackClean = true;
          break;
        case 3: // vstem
          stems += stack.length >> 1;
          stackClean = true;
          break;
        case 4: // vmoveto
          y += stack.pop()!;
          moveTo(x, y);
          stackClean = true;
          break;
        case 5: // rlineto
          while (stack.length > 0) {
            x += stack.shift()!;
            y += stack.shift()!;
            lineTo(x, y);
          }
          break;
        case 6: // hlineto
          while (stack.length > 0) {
            x += stack.shift()!;
            lineTo(x, y);
            if (stack.length === 0) {
              break;
            }
            y += stack.shift()!;
            lineTo(x, y);
          }
          break;
        case 7: // vlineto
          while (stack.length > 0) {
            y += stack.shift()!;
            lineTo(x, y);
            if (stack.length === 0) {
              break;
            }
            x += stack.shift()!;
            lineTo(x, y);
          }
          break;
        case 8: // rrcurveto
          while (stack.length > 0) {
            xa = x + stack.shift()!;
            ya = y + stack.shift()!;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb + stack.shift()!;
            y = yb + stack.shift()!;
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          break;
        case 10: // callsubr
          n = stack.pop()!;
          subrCode = null;
          if (font.isCFFCIDFont) {
            const fdIndex = font.fdSelect!.getFDIndex(glyphId);
            if (fdIndex >= 0 && fdIndex < font.fdArray.length) {
              const fontDict = font.fdArray[fdIndex];
              let subrs;
              if ((<CFFTopDict>fontDict).privateDict?.subrsIndex) {
                subrs = (<CFFTopDict>fontDict).privateDict!.subrsIndex!.objects;
              }
              if (subrs) {
                // Add subroutine bias.
                n += getSubroutineBias(subrs);
                subrCode = subrs[n];
              }
            } else {
              warn("Invalid fd index for glyph index.");
            }
          } else {
            subrCode = font.subrs[n + font.subrsBias];
          }
          if (subrCode) {
            parse(subrCode);
          }
          break;
        case 11: // return
          return;
        case 12:
          v = code[i++];
          switch (v) {
            case 34: // flex
              xa = x + stack.shift()!;
              xb = xa + stack.shift()!;
              y1 = y + stack.shift()!;
              x = xb + stack.shift()!;
              bezierCurveTo(xa, y, xb, y1, x, y1);
              xa = x + stack.shift()!;
              xb = xa + stack.shift()!;
              x = xb + stack.shift()!;
              bezierCurveTo(xa, y1, xb, y, x, y);
              break;
            case 35: // flex
              xa = x + stack.shift()!;
              ya = y + stack.shift()!;
              xb = xa + stack.shift()!;
              yb = ya + stack.shift()!;
              x = xb + stack.shift()!;
              y = yb + stack.shift()!;
              bezierCurveTo(xa, ya, xb, yb, x, y);
              xa = x + stack.shift()!;
              ya = y + stack.shift()!;
              xb = xa + stack.shift()!;
              yb = ya + stack.shift()!;
              x = xb + stack.shift()!;
              y = yb + stack.shift()!;
              bezierCurveTo(xa, ya, xb, yb, x, y);
              stack.pop(); // fd
              break;
            case 36: // hflex1
              xa = x + stack.shift()!;
              y1 = y + stack.shift()!;
              xb = xa + stack.shift()!;
              y2 = y1 + stack.shift()!;
              x = xb + stack.shift()!;
              bezierCurveTo(xa, y1, xb, y2, x, y2);
              xa = x + stack.shift()!;
              xb = xa + stack.shift()!;
              y3 = y2 + stack.shift()!;
              x = xb + stack.shift()!;
              bezierCurveTo(xa, y2, xb, y3, x, y);
              break;
            case 37: // flex1
              const x0 = x,
                y0 = y;
              xa = x + stack.shift()!;
              ya = y + stack.shift()!;
              xb = xa + stack.shift()!;
              yb = ya + stack.shift()!;
              x = xb + stack.shift()!;
              y = yb + stack.shift()!;
              bezierCurveTo(xa, ya, xb, yb, x, y);
              xa = x + stack.shift()!;
              ya = y + stack.shift()!;
              xb = xa + stack.shift()!;
              yb = ya + stack.shift()!;
              x = xb;
              y = yb;
              if (Math.abs(x - x0) > Math.abs(y - y0)) {
                x += stack.shift()!;
              } else {
                y += stack.shift()!;
              }
              bezierCurveTo(xa, ya, xb, yb, x, y);
              break;
            default:
              throw new FormatError(`unknown operator: 12 ${v}`);
          }
          break;
        case 14: // endchar
          if (stack.length >= 4) {
            const achar = stack.pop()!;
            const bchar = stack.pop()!;
            y = stack.pop()!;
            x = stack.pop()!;
            cmds.add(FontRenderOps.SAVE);
            cmds.add(FontRenderOps.TRANSLATE, [x, y]);
            let cmap = lookupCmap(
              font.cmap,
              String.fromCharCode(font.glyphNameMap[StandardEncoding[achar]])
            );
            compileCharString(
              font.glyphs[cmap.glyphId],
              cmds,
              font,
              cmap.glyphId
            );
            cmds.add(FontRenderOps.RESTORE);

            cmap = lookupCmap(
              font.cmap,
              String.fromCharCode(font.glyphNameMap[StandardEncoding[bchar]])
            );
            compileCharString(
              font.glyphs[cmap.glyphId],
              cmds,
              font,
              cmap.glyphId
            );
          }
          return;
        case 18: // hstemhm
          stems += stack.length >> 1;
          stackClean = true;
          break;
        case 19: // hintmask
          stems += stack.length >> 1;
          i += (stems + 7) >> 3;
          stackClean = true;
          break;
        case 20: // cntrmask
          stems += stack.length >> 1;
          i += (stems + 7) >> 3;
          stackClean = true;
          break;
        case 21: // rmoveto
          y += stack.pop()!;
          x += stack.pop()!;
          moveTo(x, y);
          stackClean = true;
          break;
        case 22: // hmoveto
          x += stack.pop()!;
          moveTo(x, y);
          stackClean = true;
          break;
        case 23: // vstemhm
          stems += stack.length >> 1;
          stackClean = true;
          break;
        case 24: // rcurveline
          while (stack.length > 2) {
            xa = x + stack.shift()!;
            ya = y + stack.shift()!;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb + stack.shift()!;
            y = yb + stack.shift()!;
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          x += stack.shift()!;
          y += stack.shift()!;
          lineTo(x, y);
          break;
        case 25: // rlinecurve
          while (stack.length > 6) {
            x += stack.shift()!;
            y += stack.shift()!;
            lineTo(x, y);
          }
          xa = x + stack.shift()!;
          ya = y + stack.shift()!;
          xb = xa + stack.shift()!;
          yb = ya + stack.shift()!;
          x = xb + stack.shift()!;
          y = yb + stack.shift()!;
          bezierCurveTo(xa, ya, xb, yb, x, y);
          break;
        case 26: // vvcurveto
          if (stack.length % 2) {
            x += stack.shift()!;
          }
          while (stack.length > 0) {
            xa = x;
            ya = y + stack.shift()!;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb;
            y = yb + stack.shift()!;
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          break;
        case 27: // hhcurveto
          if (stack.length % 2) {
            y += stack.shift()!;
          }
          while (stack.length > 0) {
            xa = x + stack.shift()!;
            ya = y;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb + stack.shift()!;
            y = yb;
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          break;
        case 28:
          stack.push(((code[i] << 24) | (code[i + 1] << 16)) >> 16);
          i += 2;
          break;
        case 29: // callgsubr
          n = stack.pop()! + font.gsubrsBias;
          subrCode = font.gsubrs[n];
          if (subrCode) {
            parse(subrCode);
          }
          break;
        case 30: // vhcurveto
          while (stack.length > 0) {
            xa = x;
            ya = y + stack.shift()!;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb + stack.shift()!;
            y = yb + (stack.length === 1 ? stack.shift()! : 0);
            bezierCurveTo(xa, ya, xb, yb, x, y);
            if (stack.length === 0) {
              break;
            }

            xa = x + stack.shift()!;
            ya = y;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            y = yb + stack.shift()!;
            x = xb + (stack.length === 1 ? stack.shift()! : 0);
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          break;
        case 31: // hvcurveto
          while (stack.length > 0) {
            xa = x + stack.shift()!;
            ya = y;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            y = yb + stack.shift()!;
            x = xb + (stack.length === 1 ? stack.shift()! : 0);
            bezierCurveTo(xa, ya, xb, yb, x, y);
            if (stack.length === 0) {
              break;
            }

            xa = x;
            ya = y + stack.shift()!;
            xb = xa + stack.shift()!;
            yb = ya + stack.shift()!;
            x = xb + stack.shift()!;
            y = yb + (stack.length === 1 ? stack.shift()! : 0);
            bezierCurveTo(xa, ya, xb, yb, x, y);
          }
          break;
        default:
          if (v < 32) {
            throw new FormatError(`unknown operator: ${v}`);
          }
          if (v < 247) {
            stack.push(v - 139);
          } else if (v < 251) {
            stack.push((v - 247) * 256 + code[i++] + 108);
          } else if (v < 255) {
            stack.push(-(v - 251) * 256 - code[i++] - 108);
          } else {
            stack.push(
              ((code[i] << 24) |
                (code[i + 1] << 16) |
                (code[i + 2] << 8) |
                code[i + 3]) /
              65536
            );
            i += 4;
          }
          break;
      }
      if (stackClean) {
        stack.length = 0;
      }
    }
  }
  parse(charStringCode);
}

const NOOP = <number[]>[];

class Commands {

  cmds = <number[]>[];

  add(cmd: number, args?: number[]) {
    if (args) {
      if (!isNumberArray(args, null)) {
        warn(`Commands.add - "${cmd}" has at least one non-number arg: "${args}".`);
        // "Fix" the wrong args by replacing them with 0.
        // 按理来说应该全是数字，但是如果出现不是数字的情况，那么那么需要把非数字部分过滤掉
        const newArgs = (<unknown[]>args).map(arg => (typeof arg === "number" ? arg : 0));
        this.cmds.push(cmd, ...newArgs);
      } else {
        this.cmds.push(cmd, ...args);
      }
    } else {
      this.cmds.push(cmd);
    }
  }
}

class CompiledFont {

  protected fontMatrix: TransformType;

  protected compiledGlyphs: Record<number, number[]>;

  protected compiledCharCodeToGlyphId: Record<number, number>;

  public cmap: CMapRange[] = [];

  constructor(fontMatrix: TransformType) {
    if (PlatformHelper.isTesting() && this.constructor === CompiledFont) {
      unreachable("Cannot initialize CompiledFont.");
    }

    this.fontMatrix = fontMatrix;

    this.compiledGlyphs = <Record<number, any>>Object.create(null);
    this.compiledCharCodeToGlyphId = Object.create(null);
  }

  get glyphs(): Uint8Array[] {
    return []
  }

  get isCFFCIDFont(): boolean {
    return false;
  }

  get fdSelect(): CFFFDSelect | null {
    return null;
  }

  get fdArray(): CFFDict[] {
    return [];
  }

  getPathJs(unicode: string) {
    const { charCode, glyphId } = lookupCmap(this.cmap, unicode);
    let fn = this.compiledGlyphs[glyphId],
      compileEx;
    if (!fn) {
      try {
        fn = this.compileGlyph(this.glyphs[glyphId], glyphId);
      } catch (ex) {
        fn = NOOP; // Avoid attempting to re-compile a corrupt glyph.

        compileEx = ex;
      }
      this.compiledGlyphs[glyphId] = fn;
    }
    this.compiledCharCodeToGlyphId[charCode] ??= glyphId;

    if (compileEx) {
      throw compileEx;
    }
    return fn;
  }

  compileGlyph(code: Uint8Array, glyphId: number) {
    if (!code || code.length === 0 || code[0] === 14) {
      return NOOP;
    }

    let fontMatrix = this.fontMatrix;
    if (this.isCFFCIDFont) {
      // Top DICT's FontMatrix can be ignored because CFFCompiler always
      // removes it and copies to FDArray DICTs.
      const fdIndex = this.fdSelect!.getFDIndex(glyphId);
      if (fdIndex >= 0 && fdIndex < this.fdArray.length) {
        const fontDict = this.fdArray[fdIndex];
        fontMatrix = fontDict.getByName(CFFDictKey.FontMatrix) || FONT_IDENTITY_MATRIX;
      } else {
        warn("Invalid fd index for glyph index.");
      }
    }

    const cmds = new Commands();
    cmds.add(FontRenderOps.SAVE);
    cmds.add(FontRenderOps.TRANSFORM, fontMatrix.slice());
    cmds.add(FontRenderOps.SCALE);
    this.compileGlyphImpl(code, cmds, glyphId);
    cmds.add(FontRenderOps.RESTORE);

    return cmds.cmds;
  }

  compileGlyphImpl(_code: Uint8Array, _cmds: Commands, _glyphId: number): void {
    unreachable("Children classes should implement this.");
  }

  hasBuiltPath(unicode: string) {
    const { charCode, glyphId } = lookupCmap(this.cmap, unicode);
    return (
      this.compiledGlyphs[glyphId] !== undefined &&
      this.compiledCharCodeToGlyphId[charCode] !== undefined
    );
  }
}

class TrueTypeCompiled extends CompiledFont {

  protected _glyphs: Uint8Array[];

  constructor(glyphs: Uint8Array[], cmap: CMapRange[], fontMatrix: TransformType | null) {
    super(fontMatrix || [0.000488, 0, 0, 0.000488, 0, 0]);

    this._glyphs = glyphs;
    this.cmap = cmap;
  }

  get glyphs(): Uint8Array[] {
    return this._glyphs;
  }

  compileGlyphImpl(code: Uint8Array, cmds: Commands) {
    compileGlyf(code, cmds, this);
  }
}

class Type2Compiled extends CompiledFont {

  protected _glyphs: Uint8Array[];

  public gsubrs;

  public subrs: Uint8Array[]

  protected _isCFFCIDFont: boolean;

  public gsubrsBias: number;

  public subrsBias: number;

  protected _fdSelect: CFFFDSelect;

  protected _fdArray: CFFDict[];

  public glyphNameMap: Record<string, number>;

  constructor(cffInfo: CFFInfo, cmap: CMapRange[], fontMatrix: TransformType
    , glyphNameMap: Record<string, number> | null) {
    super(fontMatrix || [0.001, 0, 0, 0.001, 0, 0]);

    this._glyphs = <Uint8Array[]>cffInfo.glyphs;
    this.gsubrs = <Uint8Array[] | null>cffInfo.gsubrs || [];
    this.subrs = <Uint8Array[] | null>cffInfo.subrs || [];
    this.cmap = cmap;
    this.glyphNameMap = glyphNameMap || getGlyphsUnicode()!;

    this.gsubrsBias = getSubroutineBias(this.gsubrs);
    this.subrsBias = getSubroutineBias(this.subrs);

    this._isCFFCIDFont = cffInfo.isCFFCIDFont;
    this._fdSelect = cffInfo.fdSelect!;
    this._fdArray = cffInfo.fdArray;
  }

  get isCFFCIDFont(): boolean {
    return this._isCFFCIDFont;
  }

  get glyphs() {
    return this._glyphs;
  }

  get fdSelect() {
    return this._fdSelect;
  }

  compileGlyphImpl(code: Uint8Array, cmds: Commands, glyphId: number) {
    compileCharString(code, cmds!, this, glyphId);
  }
}

export class FontRendererFactory {
  static create(font: Font, seacAnalysisEnabled: boolean) {
    const data = new Uint8Array(font.data!);
    let cmap, glyf, loca, cff, indexToLocFormat, unitsPerEm;
    const numTables = getUint16(data, 4);
    for (let i = 0, p = 12; i < numTables; i++, p += 16) {
      const tag = bytesToString(data.subarray(p, p + 4));
      const offset = getUint32(data, p + 8);
      const length = getUint32(data, p + 12);
      switch (tag) {
        case "cmap":
          cmap = parseCmap(data, offset, offset + length);
          break;
        case "glyf":
          glyf = data.subarray(offset, offset + length);
          break;
        case "loca":
          loca = data.subarray(offset, offset + length);
          break;
        case "head":
          unitsPerEm = getUint16(data, offset + 18);
          indexToLocFormat = getUint16(data, offset + 50);
          break;
        case "CFF ":
          cff = parseCff(data, offset, offset + length, seacAnalysisEnabled);
          break;
      }
    }

    if (glyf) {
      const fontMatrix = !unitsPerEm
        ? font.fontMatrix
        : [1 / unitsPerEm, 0, 0, 1 / unitsPerEm, 0, 0];
      return new TrueTypeCompiled(
        parseGlyfTable(glyf, loca!, indexToLocFormat!),
        cmap!,
        <TransformType>fontMatrix
      );
    }
    return new Type2Compiled(cff!, cmap!, font.fontMatrix, font.glyphNameMap);
  }
}
