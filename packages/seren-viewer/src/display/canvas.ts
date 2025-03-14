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

import { Uint8TypedArray, Glyph, isNull, assertNotNull } from "seren-common";
import { ImageMask } from "seren-common";
import {
  GroupOptions,
  OptionalContent,
  TilingPatternIR
} from "seren-common";
import { PlatformHelper, DictKey, convertBlackAndWhiteToRGBA, RGBType } from "seren-common";
import {
  assert,
  FeatureTest,
  FONT_IDENTITY_MATRIX,
  IDENTITY_MATRIX,
  ImageKind,
  info,
  OPS,
  shadow,
  TextRenderingMode,
  unreachable,
  Util,
  warn,
  PointType,
  RectType,
} from "seren-common";
import { IntentStateOperatorList, PDFObjects } from "../api";
import { CanvasAndContext, CanvasFactory } from "./canvas_factory";
import {
  getCurrentTransform,
  getCurrentTransformInverse,
  PageViewport,
  PixelsPerInch,
} from "./display_utils";
import { FilterFactory } from "./filter_factory";
import { FontFaceObject } from "./font_loader";
import { OptionalContentConfig } from "./optional_content_config";
import {
  BaseShadingPattern,
  getShadingPattern,
  PathType,
  TilingPattern,
} from "./pattern_helper";
import { TransformType } from "seren-common";

// <canvas> contexts store most of the state we need natively.
// However, PDF needs a bit more state, which we store here.
// Minimal font size that would be used during canvas fillText operations.
const MIN_FONT_SIZE = 16;
// Maximum font size that would be used during canvas fillText operations.
const MAX_FONT_SIZE = 100;

// Defines the time the `executeOperatorList`-method is going to be executing
// before it stops and schedules a continue of execution.
const EXECUTION_TIME = 15; // ms
// Defines the number of steps before checking the execution time.
const EXECUTION_STEPS = 10;

// To disable Type3 compilation, set the value to `-1`.
const MAX_SIZE_TO_COMPILE = 1000;

const FULL_CHUNK_HEIGHT = 16;

/**
 * Overrides certain methods on a 2d ctx so that when they are called they
 * will also call the same method on the destCtx. The methods that are
 * overridden are all the transformation state modifiers, path creation, and
 * save/restore. We only forward these specific methods because they are the
 * only state modifiers that we cannot copy over when we switch contexts.
 *
 * To remove mirroring call `ctx._removeMirroring()`.
 *
 * @param {Object} ctx - The 2d canvas context that will duplicate its calls on
 *   the destCtx.
 * @param {Object} destCtx - The 2d canvas context that will receive the
 *   forwarded calls.
 */
function mirrorContextOperations(ctx: CanvasRenderingContext2D, destCtx: CanvasRenderingContext2D) {
  if (ctx._removeMirroring) {
    throw new Error("Context is already forwarding operations.");
  }
  ctx.__originalSave = ctx.save;
  ctx.__originalRestore = ctx.restore;
  ctx.__originalRotate = ctx.rotate;
  ctx.__originalScale = ctx.scale;
  ctx.__originalTranslate = ctx.translate;
  ctx.__originalTransform = ctx.transform;
  ctx.__originalSetTransform = ctx.setTransform;
  ctx.__originalResetTransform = ctx.resetTransform;
  ctx.__originalClip = ctx.clip;
  ctx.__originalMoveTo = ctx.moveTo;
  ctx.__originalLineTo = ctx.lineTo;
  ctx.__originalBezierCurveTo = ctx.bezierCurveTo;
  ctx.__originalRect = ctx.rect;
  ctx.__originalClosePath = ctx.closePath;
  ctx.__originalBeginPath = ctx.beginPath;

  ctx._removeMirroring = () => {
    ctx.save = ctx.__originalSave!;
    ctx.restore = ctx.__originalRestore!;
    ctx.rotate = ctx.__originalRotate!;
    ctx.scale = ctx.__originalScale!;
    ctx.translate = ctx.__originalTranslate!;
    ctx.transform = ctx.__originalTransform!;
    ctx.setTransform = ctx.__originalSetTransform!;
    ctx.resetTransform = ctx.__originalResetTransform!;

    ctx.clip = ctx.__originalClip!;
    ctx.moveTo = ctx.__originalMoveTo!;
    ctx.lineTo = ctx.__originalLineTo!;
    ctx.bezierCurveTo = ctx.__originalBezierCurveTo!;
    ctx.rect = ctx.__originalRect!;
    ctx.closePath = ctx.__originalClosePath!;
    ctx.beginPath = ctx.__originalBeginPath!;
    delete ctx._removeMirroring;
  };

  ctx.save = function ctxSave() {
    destCtx.save();
    this.__originalSave?.();
  };

  ctx.restore = function ctxRestore() {
    destCtx.restore();
    this.__originalRestore?.();
  };

  ctx.translate = function ctxTranslate(x: number, y: number) {
    destCtx.translate(x, y);
    this.__originalTranslate?.(x, y);
  };

  ctx.scale = function ctxScale(x: number, y: number) {
    destCtx.scale(x, y);
    this.__originalScale?.(x, y);
  };

  ctx.transform = function ctxTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    destCtx.transform(a, b, c, d, e, f);
    this.__originalTransform?.(a, b, c, d, e, f);
  };

  ctx.setTransform = function (a?: number | DOMMatrix2DInit, b?: number, c?: number, d?: number, e?: number, f?: number) {
    if (typeof a === 'object') {
      throw new Error('cannot set transform, because of wronging invoke.')
    }
    destCtx.setTransform(a!, b!, c!, d!, e!, f!);
    this.__originalSetTransform?.(a!, b!, c!, d!, e!, f!);
  };

  ctx.resetTransform = function ctxResetTransform() {
    destCtx.resetTransform();
    this.__originalResetTransform?.();
  };

  ctx.rotate = function ctxRotate(angle) {
    destCtx.rotate(angle);
    this.__originalRotate?.(angle);
  };

  ctx.clip = function ctxRotate(rule?: CanvasFillRule | Path2D) {
    if (rule instanceof Path2D) {
      throw new Error('Unsupport Invoke,beacuse rule can only be type CanvasFillRule.')
    }
    destCtx.clip(rule);
    this.__originalClip?.(rule);
  };

  ctx.moveTo = function (x, y) {
    destCtx.moveTo(x, y);
    this.__originalMoveTo?.(x, y);
  };

  ctx.lineTo = function (x, y) {
    destCtx.lineTo(x, y);
    this.__originalLineTo?.(x, y);
  };

  ctx.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
    destCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    this.__originalBezierCurveTo?.(cp1x, cp1y, cp2x, cp2y, x, y);
  };

  ctx.rect = function (x, y, width, height) {
    destCtx.rect(x, y, width, height);
    this.__originalRect?.(x, y, width, height);
  };

  ctx.closePath = function () {
    destCtx.closePath();
    this.__originalClosePath?.();
  };

  ctx.beginPath = function () {
    destCtx.beginPath();
    this.__originalBeginPath?.();
  };
}

export class CachedCanvases {

  protected canvasFactory: CanvasFactory;

  protected cache: Map<string, CanvasAndContext>;

  constructor(canvasFactory: CanvasFactory) {
    this.canvasFactory = canvasFactory;
    this.cache = new Map();
  }

  getCanvas(id: string, width: number, height: number): CanvasAndContext {
    let canvasEntry;
    if (this.cache.has(id)) {
      canvasEntry = this.cache.get(id)!;
      this.canvasFactory.reset(canvasEntry, width, height);
    } else {
      canvasEntry = this.canvasFactory.create(width, height);
      this.cache.set(id, canvasEntry);
    }
    return canvasEntry;
  }

  delete(id: string) {
    this.cache.delete(id);
  }

  clear() {
    for (const [_k, canvasEntry] of this.cache) {
      this.canvasFactory.destroy(canvasEntry);
    }
    this.cache.clear();
  }
}

function drawImageAtIntegerCoords(
  ctx: CanvasRenderingContext2D, srcImg: CanvasImageSource,
  srcX: number, srcY: number, srcW: number, srcH: number,
  destX: number, destY: number, destW: number, destH: number
): number[] {
  const [a, b, c, d, tx, ty] = getCurrentTransform(ctx);
  if (b === 0 && c === 0) {
    // top-left corner is at (X, Y) and
    // bottom-right one is at (X + width, Y + height).

    // If leftX is 4.321 then it's rounded to 4.
    // If width is 10.432 then it's rounded to 11 because
    // rightX = leftX + width = 14.753 which is rounded to 15
    // so after rounding the total width is 11 (15 - 4).
    // It's why we can't just floor/ceil uniformly, it just depends
    // on the values we've.

    const tlX = destX * a + tx;
    const rTlX = Math.round(tlX);
    const tlY = destY * d + ty;
    const rTlY = Math.round(tlY);
    const brX = (destX + destW) * a + tx;

    // Some pdf contains images with 1x1 images so in case of 0-width after
    // scaling we must fallback on 1 to be sure there is something.
    const rWidth = Math.abs(Math.round(brX) - rTlX) || 1;
    const brY = (destY + destH) * d + ty;
    const rHeight = Math.abs(Math.round(brY) - rTlY) || 1;

    // We must apply a transformation in order to apply it on the image itself.
    // For example if a == 1 && d == -1, it means that the image itself is
    // mirrored w.r.t. the x-axis.
    ctx.setTransform(Math.sign(a), 0, 0, Math.sign(d), rTlX, rTlY);
    ctx.drawImage(srcImg, srcX, srcY, srcW, srcH, 0, 0, rWidth, rHeight);
    ctx.setTransform(a, b, c, d, tx, ty);

    return [rWidth, rHeight];
  }

  if (a === 0 && d === 0) {
    // This path is taken in issue9462.pdf (page 3).
    const tlX = destY * c + tx;
    const rTlX = Math.round(tlX);
    const tlY = destX * b + ty;
    const rTlY = Math.round(tlY);
    const brX = (destY + destH) * c + tx;
    const rWidth = Math.abs(Math.round(brX) - rTlX) || 1;
    const brY = (destX + destW) * b + ty;
    const rHeight = Math.abs(Math.round(brY) - rTlY) || 1;

    ctx.setTransform(0, Math.sign(b), Math.sign(c), 0, rTlX, rTlY);
    ctx.drawImage(srcImg, srcX, srcY, srcW, srcH, 0, 0, rHeight, rWidth);
    ctx.setTransform(a, b, c, d, tx, ty);

    return [rHeight, rWidth];
  }

  // Not a scale matrix so let the render handle the case without rounding.
  ctx.drawImage(srcImg, srcX, srcY, srcW, srcH, destX, destY, destW, destH);

  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  return [scaleX * destW, scaleY * destH];
}

function compileType3Glyph(imgData: {
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  interpolate: number[];
  count: number;
}) {
  const { width, height } = imgData;
  if (width > MAX_SIZE_TO_COMPILE || height > MAX_SIZE_TO_COMPILE) {
    return null;
  }

  const POINT_TO_PROCESS_LIMIT = 1000;
  const POINT_TYPES = new Uint8Array([
    0, 2, 4, 0, 1, 0, 5, 4, 8, 10, 0, 8, 0, 2, 1, 0,
  ]);

  const width1 = width + 1;
  let points: Uint8Array<ArrayBuffer> | null = new Uint8Array(width1 * (height + 1));
  let i, j, j0;

  // decodes bit-packed mask data
  const lineSize = (width + 7) & ~7;
  let data: Uint8Array<ArrayBuffer> | null = new Uint8Array(lineSize * height);
  let pos = 0;
  for (const elem of imgData.data) {
    let mask = 128;
    while (mask > 0) {
      data[pos++] = elem & mask ? 0 : 255;
      mask >>= 1;
    }
  }

  // finding interesting points: every point is located between mask pixels,
  // so there will be points of the (width + 1)x(height + 1) grid. Every point
  // will have flags assigned based on neighboring mask pixels:
  //   4 | 8
  //   --P--
  //   2 | 1
  // We are interested only in points with the flags:
  //   - outside corners: 1, 2, 4, 8;
  //   - inside corners: 7, 11, 13, 14;
  //   - and, intersections: 5, 10.
  let count = 0;
  pos = 0;
  if (data[pos] !== 0) {
    points[0] = 1;
    ++count;
  }
  for (j = 1; j < width; j++) {
    if (data[pos] !== data[pos + 1]) {
      points[j] = data[pos] ? 2 : 1;
      ++count;
    }
    pos++;
  }
  if (data[pos] !== 0) {
    points[j] = 2;
    ++count;
  }
  for (i = 1; i < height; i++) {
    pos = i * lineSize;
    j0 = i * width1;
    if (data[pos - lineSize] !== data[pos]) {
      points[j0] = data[pos] ? 1 : 8;
      ++count;
    }
    // 'sum' is the position of the current pixel configuration in the 'TYPES'
    // array (in order 8-1-2-4, so we can use '>>2' to shift the column).
    let sum = (data[pos] ? 4 : 0) + (data[pos - lineSize] ? 8 : 0);
    for (j = 1; j < width; j++) {
      sum =
        (sum >> 2) +
        (data[pos + 1] ? 4 : 0) +
        (data[pos - lineSize + 1] ? 8 : 0);
      if (POINT_TYPES[sum]) {
        points[j0 + j] = POINT_TYPES[sum];
        ++count;
      }
      pos++;
    }
    if (data[pos - lineSize] !== data[pos]) {
      points[j0 + j] = data[pos] ? 2 : 4;
      ++count;
    }

    if (count > POINT_TO_PROCESS_LIMIT) {
      return null;
    }
  }

  pos = lineSize * (height - 1);
  j0 = i * width1;
  if (data[pos] !== 0) {
    points[j0] = 8;
    ++count;
  }
  for (j = 1; j < width; j++) {
    if (data[pos] !== data[pos + 1]) {
      points[j0 + j] = data[pos] ? 4 : 8;
      ++count;
    }
    pos++;
  }
  if (data[pos] !== 0) {
    points[j0 + j] = 4;
    ++count;
  }
  if (count > POINT_TO_PROCESS_LIMIT) {
    return null;
  }

  // building outlines
  const steps = new Int32Array([0, width1, -1, 0, -width1, 0, 0, 0, 1]);
  const path = new Path2D();

  for (i = 0; count && i <= height; i++) {
    let p = i * width1;
    const end = p + width;
    while (p < end && !points[p]) {
      p++;
    }
    if (p === end) {
      continue;
    }
    path.moveTo(p % width1, i);

    const p0 = p;
    let type = points[p];
    do {
      const step = steps[type];
      do {
        p += step;
      } while (!points[p]);

      const pp = points[p];
      if (pp !== 5 && pp !== 10) {
        // set new direction
        type = pp;
        // delete mark
        points[p] = 0;
      } else {
        // type is 5 or 10, ie, a crossing
        // set new direction
        type = pp & ((0x33 * type) >> 4);
        // set new type for "future hit"
        points[p] &= (type >> 2) | (type << 2);
      }
      path.lineTo(p % width1, (p / width1) | 0);

      if (!points[p]) {
        --count;
      }
    } while (p0 !== p);
    --i;
  }

  // Immediately release the, potentially large, `Uint8Array`s after parsing.
  data = null;
  points = null;

  const drawOutline = function (c: CanvasRenderingContext2D) {
    c.save();
    // the path shall be painted in [0..1]x[0..1] space
    c.scale(1 / width, -1 / height);
    c.translate(0, -height);
    c.fill(path);
    c.beginPath();
    c.restore();
  };

  return drawOutline;
}

class CanvasExtraState {

  public clipBox: RectType | null = null;

  protected alphaIsShape: boolean;

  public fontSize: number;

  public fontSizeScale: number;

  public textMatrix: TransformType;

  public textMatrixScale: number;

  public fontMatrix: TransformType;

  public leading: number;

  public x: number;

  public y: number;

  public lineX: number;

  public lineY: number;

  public charSpacing: number;

  public wordSpacing: number;

  public textHScale: number;

  public textRenderingMode: number;

  public textRise: number;

  public fillColor: string | BaseShadingPattern | TilingPattern;

  public strokeColor: string | BaseShadingPattern | TilingPattern;

  public patternFill: boolean;

  public fillAlpha: number;

  public strokeAlpha: number;

  public lineWidth: number;

  public transferMaps: string;

  protected minX: number | null = null;

  protected minY: number | null = null;

  protected maxX: number | null = null;

  protected maxY: number | null = null;

  public activeSMask: GroupSMask | null;

  public fontDirection: number | null = null;

  public font: FontFaceObject | null = null;

  constructor(width: number, height: number) {
    // Are soft masks and alpha values shapes or opacities?
    this.alphaIsShape = false;
    this.fontSize = 0;
    this.fontSizeScale = 1;
    this.textMatrix = IDENTITY_MATRIX;
    this.textMatrixScale = 1;
    this.fontMatrix = FONT_IDENTITY_MATRIX;
    this.leading = 0;
    // Current point (in user coordinates)
    this.x = 0;
    this.y = 0;
    // Start of text line (in text coordinates)
    this.lineX = 0;
    this.lineY = 0;
    // Character and word spacing
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.textHScale = 1;
    this.textRenderingMode = TextRenderingMode.FILL;
    this.textRise = 0;
    // Default fore and background colors
    this.fillColor = "#000000";
    this.strokeColor = "#000000";
    this.patternFill = false;
    // Note: fill alpha applies to all non-stroking operations
    this.fillAlpha = 1;
    this.strokeAlpha = 1;
    this.lineWidth = 1;
    this.activeSMask = null;
    this.transferMaps = "none";

    this.startNewPathAndClipBox([0, 0, width, height]);
  }

  clone() {
    const clone = Object.create(this);
    clone.clipBox = this.clipBox!.slice();
    return clone;
  }

  setCurrentPoint(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  updatePathMinMax(transform: TransformType, x: number, y: number) {
    [x, y] = Util.applyTransform([x, y], transform);
    this.minX = Math.min(this.minX!, x);
    this.minY = Math.min(this.minY!, y);
    this.maxX = Math.max(this.maxX!, x);
    this.maxY = Math.max(this.maxY!, y);
  }

  updateRectMinMax(transform: TransformType, rect: RectType) {
    const p1 = Util.applyTransform(rect as unknown as PointType, transform);
    const p2 = Util.applyTransform(<PointType>rect.slice(2), transform);
    const p3 = Util.applyTransform([rect[0], rect[3]], transform);
    const p4 = Util.applyTransform([rect[2], rect[1]], transform);

    this.minX = Math.min(this.minX!, p1[0], p2[0], p3[0], p4[0]);
    this.minY = Math.min(this.minY!, p1[1], p2[1], p3[1], p4[1]);
    this.maxX = Math.max(this.maxX!, p1[0], p2[0], p3[0], p4[0]);
    this.maxY = Math.max(this.maxY!, p1[1], p2[1], p3[1], p4[1]);
  }

  updateScalingPathMinMax(transform: TransformType, minMax: RectType) {
    Util.scaleMinMax(transform, minMax);
    this.minX = Math.min(this.minX!, minMax[0]);
    this.minY = Math.min(this.minY!, minMax[1]);
    this.maxX = Math.max(this.maxX!, minMax[2]);
    this.maxY = Math.max(this.maxY!, minMax[3]);
  }

  updateCurvePathMinMax(
    transform: TransformType,
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    minMax: RectType | null
  ) {
    const box = Util.bezierBoundingBox(x0, y0, x1, y1, x2, y2, x3, y3, minMax) as RectType;
    if (minMax) {
      return;
    }
    this.updateRectMinMax(transform, box);
  }

  getPathBoundingBox(pathType = PathType.FILL, transform: TransformType | null = null) {
    const box: RectType = [this.minX!, this.minY!, this.maxX!, this.maxY!];
    if (pathType === PathType.STROKE) {
      if (!transform) {
        unreachable("Stroke bounding box must include transform.");
      }
      // Stroked paths can be outside of the path bounding box by 1/2 the line
      // width.
      const scale = Util.singularValueDecompose2dScale(transform);
      const xStrokePad = (scale[0] * this.lineWidth) / 2;
      const yStrokePad = (scale[1] * this.lineWidth) / 2;
      box[0] -= xStrokePad;
      box[1] -= yStrokePad;
      box[2] += xStrokePad;
      box[3] += yStrokePad;
    }
    return box;
  }

  updateClipFromPath() {
    const intersect = Util.intersect(this.clipBox!, this.getPathBoundingBox());
    this.startNewPathAndClipBox(intersect || [0, 0, 0, 0]);
  }

  isEmptyClip() {
    return this.minX === Infinity;
  }

  startNewPathAndClipBox(box: RectType) {
    this.clipBox = box;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = 0;
    this.maxY = 0;
  }

  getClippedPathBoundingBox(pathType = PathType.FILL, transform: TransformType | null = null) {
    return Util.intersect(
      this.clipBox!,
      this.getPathBoundingBox(pathType, transform)
    );
  }
}

function putBinaryImageData(ctx: CanvasRenderingContext2D, imgData: ImageData | {
  width: number, height: number, data: Uint8TypedArray | null, kind?: ImageKind,
}) {
  if (typeof ImageData !== "undefined" && imgData instanceof ImageData) {
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  assert(!(imgData instanceof ImageData), "");

  // Put the image data to the canvas in chunks, rather than putting the
  // whole image at once.  This saves JS memory, because the ImageData object
  // is smaller. It also possibly saves C++ memory within the implementation
  // of putImageData(). (E.g. in Firefox we make two short-lived copies of
  // the data passed to putImageData()). |n| shouldn't be too small, however,
  // because too many putImageData() calls will slow things down.
  //
  // Note: as written, if the last chunk is partial, the putImageData() call
  // will (conceptually) put pixels past the bounds of the canvas.  But
  // that's ok; any such pixels are ignored.

  const height = imgData.height, width = imgData.width;
  const partialChunkHeight = height % FULL_CHUNK_HEIGHT;
  const fullChunks = (height - partialChunkHeight) / FULL_CHUNK_HEIGHT;
  const totalChunks = partialChunkHeight === 0 ? fullChunks : fullChunks + 1;

  const chunkImgData = ctx.createImageData(width, FULL_CHUNK_HEIGHT);
  let srcPos = 0, destPos;
  const src = imgData.data!;
  const dest = chunkImgData.data;
  let i, j, thisChunkHeight, elemsInThisChunk;

  // There are multiple forms in which the pixel data can be passed, and
  // imgData.kind tells us which one this is.
  if (imgData.kind === ImageKind.GRAYSCALE_1BPP) {
    // Grayscale, 1 bit per pixel (i.e. black-and-white).
    const srcLength = src.byteLength;
    const dest32 = new Uint32Array(dest.buffer, 0, dest.byteLength >> 2);
    const dest32DataLength = dest32.length;
    const fullSrcDiff = (width + 7) >> 3;
    const white = 0xffffffff;
    const black = FeatureTest.isLittleEndian ? 0xff000000 : 0x000000ff;

    for (i = 0; i < totalChunks; i++) {
      thisChunkHeight = i < fullChunks ? FULL_CHUNK_HEIGHT : partialChunkHeight;
      destPos = 0;
      for (j = 0; j < thisChunkHeight; j++) {
        const srcDiff = srcLength - srcPos;
        let k = 0;
        const kEnd = srcDiff > fullSrcDiff ? width : srcDiff * 8 - 7;
        const kEndUnrolled = kEnd & ~7;
        let mask = 0;
        let srcByte = 0;
        for (; k < kEndUnrolled; k += 8) {
          srcByte = src[srcPos++];
          dest32[destPos++] = srcByte & 128 ? white : black;
          dest32[destPos++] = srcByte & 64 ? white : black;
          dest32[destPos++] = srcByte & 32 ? white : black;
          dest32[destPos++] = srcByte & 16 ? white : black;
          dest32[destPos++] = srcByte & 8 ? white : black;
          dest32[destPos++] = srcByte & 4 ? white : black;
          dest32[destPos++] = srcByte & 2 ? white : black;
          dest32[destPos++] = srcByte & 1 ? white : black;
        }
        for (; k < kEnd; k++) {
          if (mask === 0) {
            srcByte = src[srcPos++];
            mask = 128;
          }

          dest32[destPos++] = srcByte & mask ? white : black;
          mask >>= 1;
        }
      }
      // We ran out of input. Make all remaining pixels transparent.
      while (destPos < dest32DataLength) {
        dest32[destPos++] = 0;
      }

      ctx.putImageData(chunkImgData, 0, i * FULL_CHUNK_HEIGHT);
    }
  } else if (imgData.kind === ImageKind.RGBA_32BPP) {
    // RGBA, 32-bits per pixel.
    j = 0;
    elemsInThisChunk = width * FULL_CHUNK_HEIGHT * 4;
    for (i = 0; i < fullChunks; i++) {
      dest.set(src.subarray(srcPos, srcPos + elemsInThisChunk));
      srcPos += elemsInThisChunk;

      ctx.putImageData(chunkImgData, 0, j);
      j += FULL_CHUNK_HEIGHT;
    }
    if (i < totalChunks) {
      elemsInThisChunk = width * partialChunkHeight * 4;
      dest.set(src.subarray(srcPos, srcPos + elemsInThisChunk));

      ctx.putImageData(chunkImgData, 0, j);
    }
  } else if (imgData.kind === ImageKind.RGB_24BPP) {
    // RGB, 24-bits per pixel.
    thisChunkHeight = FULL_CHUNK_HEIGHT;
    elemsInThisChunk = width * thisChunkHeight;
    for (i = 0; i < totalChunks; i++) {
      if (i >= fullChunks) {
        thisChunkHeight = partialChunkHeight;
        elemsInThisChunk = width * thisChunkHeight;
      }

      destPos = 0;
      for (j = elemsInThisChunk; j--;) {
        dest[destPos++] = src[srcPos++];
        dest[destPos++] = src[srcPos++];
        dest[destPos++] = src[srcPos++];
        dest[destPos++] = 255;
      }

      ctx.putImageData(chunkImgData, 0, i * FULL_CHUNK_HEIGHT);
    }
  } else {
    throw new Error(`bad image kind: ${imgData.kind}`);
  }
}

function putBinaryImageMask(
  ctx: CanvasRenderingContext2D,
  imgData: {
    bitmap: CanvasImageSource | null,
    height: number,
    width: number,
    data: Uint8Array<ArrayBuffer>
  }
) {
  if (imgData.bitmap) {
    // The bitmap has been created in the worker.
    ctx.drawImage(imgData.bitmap, 0, 0);
    return;
  }

  // Slow path: OffscreenCanvas isn't available in the worker.
  const height = imgData.height,
    width = imgData.width;
  const partialChunkHeight = height % FULL_CHUNK_HEIGHT;
  const fullChunks = (height - partialChunkHeight) / FULL_CHUNK_HEIGHT;
  const totalChunks = partialChunkHeight === 0 ? fullChunks : fullChunks + 1;

  const chunkImgData = ctx.createImageData(width, FULL_CHUNK_HEIGHT);
  let srcPos = 0;
  const src = imgData.data;
  const dest = chunkImgData.data;

  for (let i = 0; i < totalChunks; i++) {
    const thisChunkHeight =
      i < fullChunks ? FULL_CHUNK_HEIGHT : partialChunkHeight;

    // Expand the mask so it can be used by the canvas.  Any required
    // inversion has already been handled.

    ({ srcPos } = convertBlackAndWhiteToRGBA(src, dest, width, thisChunkHeight, false, 0, srcPos));

    ctx.putImageData(chunkImgData, 0, i * FULL_CHUNK_HEIGHT);
  }
}

function copyCtxState(sourceCtx: CanvasRenderingContext2D, destCtx: CanvasRenderingContext2D) {

  function copyIfNotNull<T>(valFn: () => T | undefined, setFn: (data: T) => void) {
    const val = valFn();
    if (!!val) {
      setFn(val);
    }
  }

  copyIfNotNull(() => sourceCtx.strokeStyle, v => destCtx.strokeStyle = v);
  copyIfNotNull(() => sourceCtx.fillStyle, v => destCtx.fillStyle = v);
  copyIfNotNull(() => sourceCtx.fillRule, v => destCtx.fillRule = v);
  copyIfNotNull(() => sourceCtx.globalAlpha, v => destCtx.globalAlpha = v);
  copyIfNotNull(() => sourceCtx.lineWidth, v => destCtx.lineWidth = v);
  copyIfNotNull(() => sourceCtx.lineCap, v => destCtx.lineCap = v);
  copyIfNotNull(() => sourceCtx.lineJoin, v => destCtx.lineJoin = v);
  copyIfNotNull(() => sourceCtx.miterLimit, v => destCtx.miterLimit = v);
  copyIfNotNull(() => sourceCtx.globalCompositeOperation, v => destCtx.globalCompositeOperation = v);
  copyIfNotNull(() => sourceCtx.font, v => destCtx.font = v);
  copyIfNotNull(() => sourceCtx.filter, v => destCtx.filter = v);

  if (sourceCtx.setLineDash !== undefined) {
    destCtx.setLineDash(sourceCtx.getLineDash());
    destCtx.lineDashOffset = sourceCtx.lineDashOffset;
  }
}

function resetCtxToDefault(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = ctx.fillStyle = "#000000";
  ctx.fillRule = "nonzero";
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.miterLimit = 10;
  ctx.globalCompositeOperation = "source-over";
  ctx.font = "10px sans-serif";
  if (ctx.setLineDash !== undefined) {
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  if (PlatformHelper.isMozCental()) {
    const { filter } = ctx;
    if (filter !== "none" && filter !== "") {
      ctx.filter = "none";
    }
  }
}

function getImageSmoothingEnabled(transform: TransformType, interpolate: number[]) {
  // In section 8.9.5.3 of the PDF spec, it's mentioned that the interpolate
  // flag should be used when the image is upscaled.
  // In Firefox, smoothing is always used when downscaling images (bug 1360415).

  if (interpolate) {
    return true;
  }

  const scale = Util.singularValueDecompose2dScale(transform);
  // Round to a 32bit float so that `<=` check below will pass for numbers that
  // are very close, but not exactly the same 64bit floats.
  scale[0] = Math.fround(scale[0]);
  scale[1] = Math.fround(scale[1]);
  const actualScale = Math.fround(
    (globalThis.devicePixelRatio || 1) * PixelsPerInch.PDF_TO_CSS_UNITS
  );
  return scale[0] <= actualScale && scale[1] <= actualScale;
}

const LINE_CAP_STYLES: CanvasLineCap[] = ["butt", "round", "square"];
const LINE_JOIN_STYLES: CanvasLineJoin[] = ["miter", "round", "bevel"];
const NORMAL_CLIP = {};
const EO_CLIP = {};

export interface CanvasGraphicsFactory {
  createCanvasGraphics(ctx: CanvasRenderingContext2D): CanvasGraphics;
}

interface PositionTransformType {
  transform: TransformType,
  x: number,
  y: number,
  w: number,
  h: number,
}

interface GroupSMask {
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D;
  offsetX: number;
  offsetY: number;
  subtype: string;
  backdrop: number[] | Uint8ClampedArray<ArrayBuffer>;
  transferMap: Uint8Array<ArrayBuffer> | null;
  startTransformInverse: null;
}

const MethodMap = new Map<OPS, keyof CanvasGraphics>();

// 这里应该要有handle完的arg类型，但是这种arg类型不太好强制管理起来
// 强制起来得打开一个开关，开关检测args处理的对不对
function handle(ops: OPS) {
  return function (_target: CanvasGraphics, propertyKey: keyof CanvasGraphics) {
    if (MethodMap.has(ops)) {
      throw new Error("不能够为一个操作配置多个方法");
    }
    MethodMap.set(ops, propertyKey);
  }
}

export class CanvasGraphics {

  public ctx: CanvasRenderingContext2D;

  public current: CanvasExtraState;

  protected operatorMap = new Map<OPS, Function>();

  protected pendingEOFill: boolean;

  protected commonObjs: PDFObjects;

  protected objs: PDFObjects;

  protected canvasFactory: CanvasFactory;

  protected filterFactory: FilterFactory;

  public groupLevel: number;

  protected smaskCounter: number;

  public cachedCanvases: CachedCanvases;

  protected annotationCanvasMap: Map<string, HTMLCanvasElement> | null;

  protected viewportScale: number;

  protected outputScaleX: number;

  protected outputScaleY: number;

  protected contentVisible: boolean;

  protected _cachedScaleForStroking: [number, number];

  protected groupStack: CanvasRenderingContext2D[];

  protected stateStack: CanvasExtraState[];

  protected baseTransformStack: (TransformType | null)[];

  public baseTransform: TransformType | null;

  protected cachedPatterns: Map<string | Uint8ClampedArray<ArrayBuffer>, BaseShadingPattern>;

  protected _cachedBitmapsMap: Map<any, any>;

  protected compositeCtx: CanvasRenderingContext2D | null = null;

  protected transparentCanvas: HTMLCanvasElement | null = null;

  protected suspendedCtx: CanvasRenderingContext2D | null;

  protected annotationCanvas: CanvasAndContext | null = null;

  protected _cachedGetSinglePixelWidth: null | number;

  protected pendingClip: typeof NORMAL_CLIP | typeof EO_CLIP | null = null;

  protected markedContentStack: { visible: boolean }[];

  protected pendingTextPaths: {
    transform: TransformType;
    x: number;
    y: number;
    fontSize: number;
    addToPath: ((ctx: CanvasRenderingContext2D, size?: number) => void) | null;
  }[] | null = null;

  public pageColors: { background: string; foreground: string; } | null;

  public optionalContentConfig: OptionalContentConfig;

  public tempSMask: GroupSMask | null;

  public smaskStack: GroupSMask[];

  public processingType3: Glyph | null;

  constructor(
    canvasCtx: CanvasRenderingContext2D,
    commonObjs: PDFObjects,
    objs: PDFObjects,
    canvasFactory: CanvasFactory,
    filterFactory: FilterFactory,
    optionalContentConfig: OptionalContentConfig,
    markedContentStack: { visible: boolean }[] | null = null,
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null = null,
    pageColors: { background: string; foreground: string; } | null = null
  ) {
    this.ctx = canvasCtx;
    this.current = new CanvasExtraState(
      this.ctx.canvas.width,
      this.ctx.canvas.height
    );
    this.stateStack = [];
    this.pendingClip = null;
    this.pendingEOFill = false;
    this.commonObjs = commonObjs;
    this.objs = objs;
    this.canvasFactory = canvasFactory;
    this.filterFactory = filterFactory;
    this.groupStack = [];
    this.processingType3 = null;
    // Patterns are painted relative to the initial page/form transform, see
    // PDF spec 8.7.2 NOTE 1.
    this.baseTransform = null;
    this.baseTransformStack = [];
    this.groupLevel = 0;
    this.smaskStack = [];
    this.smaskCounter = 0;
    this.tempSMask = null;
    this.suspendedCtx = null;
    this.contentVisible = true;
    this.markedContentStack = markedContentStack || [];
    this.optionalContentConfig = optionalContentConfig;
    this.cachedCanvases = new CachedCanvases(this.canvasFactory);
    this.cachedPatterns = new Map();
    this.annotationCanvasMap = annotationCanvasMap;
    this.viewportScale = 1;
    this.outputScaleX = 1;
    this.outputScaleY = 1;
    this.pageColors = pageColors;

    this._cachedScaleForStroking = [-1, 0];
    this._cachedGetSinglePixelWidth = null;
    this._cachedBitmapsMap = new Map();
    this.initOperatorMap();
  }

  protected initOperatorMap() {
    for (const [ops, func] of MethodMap) {
      if (typeof this[func] === 'function') {
        if (this.operatorMap.has(ops)) {
          throw new Error(ops + '操作设置了多个处理方法');
        }
        this.operatorMap.set(ops, this[func]);
      }
    }
  }

  getObject(data: string | unknown, fallback: unknown = null) {
    if (typeof data === "string") {
      return data.startsWith("g_")
        ? this.commonObjs.get(data)
        : this.objs.get(data);
    }
    return fallback;
  }


  beginDrawing(
    transform: TransformType | null,
    viewport: PageViewport,
    transparency = false,
    background: string | CanvasGradient | CanvasPattern | null = null
  ) {
    // For pdfs that use blend modes we have to clear the canvas else certain
    // blend modes can look wrong since we'd be blending with a white
    // backdrop. The problem with a transparent backdrop though is we then
    // don't get sub pixel anti aliasing on text, creating temporary
    // transparent canvas when we have blend modes.
    const width = this.ctx.canvas.width;
    const height = this.ctx.canvas.height;

    const savedFillStyle = this.ctx.fillStyle;
    this.ctx.fillStyle = background || "#ffffff";
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.fillStyle = savedFillStyle;

    if (transparency) {
      const transparentCanvas = this.cachedCanvases.getCanvas(
        "transparent",
        width,
        height
      );
      this.compositeCtx = this.ctx;
      this.transparentCanvas = transparentCanvas.canvas;
      this.ctx = transparentCanvas.context!;
      this.ctx.save();
      // The transform can be applied before rendering, transferring it to
      // the new canvas.
      this.ctx.transform(...getCurrentTransform(this.compositeCtx));
    }

    this.ctx.save();
    resetCtxToDefault(this.ctx);
    if (transform) {
      this.ctx.transform(...transform as TransformType);
      this.outputScaleX = transform[0];
      this.outputScaleY = transform[0];
    }
    this.ctx.transform(...viewport.transform);
    this.viewportScale = viewport.scale;

    this.baseTransform = getCurrentTransform(this.ctx);
  }

  executeOperatorList(
    operatorList: IntentStateOperatorList,
    executionStartIdx: number | null = null,
    continueCallback: (() => void) | null = null,
  ) {
    const argsArray = operatorList.argsArray;
    const fnArray = operatorList.fnArray;
    let i = executionStartIdx || 0;
    const argsArrayLen = argsArray.length;

    // Sometimes the OperatorList to execute is empty.
    if (argsArrayLen === i) {
      return i;
    }

    const chunkOperations = argsArrayLen - i > EXECUTION_STEPS &&
      typeof continueCallback === "function";
    const endTime = chunkOperations ? Date.now() + EXECUTION_TIME : 0;
    let steps = 0;

    const commonObjs = this.commonObjs;
    const objs = this.objs;
    let fnId;

    while (true) {

      fnId = fnArray[i];

      if (fnId !== OPS.dependency) {
        // eslint-disable-next-line prefer-spread
        this.operatorMap.get(fnId)!.apply(this, argsArray[i]);
      } else {
        for (const depObjId of argsArray![i]!) {
          const objsPool = depObjId.startsWith("g_") ? commonObjs : objs;

          // If the promise isn't resolved yet, add the continueCallback
          // to the promise and bail out.
          if (!objsPool.has(depObjId)) {
            objsPool.get(depObjId, continueCallback);
            return i;
          }
        }
      }

      i++;

      // If the entire operatorList was executed, stop as were done.
      if (i === argsArrayLen) {
        return i;
      }

      // If the execution took longer then a certain amount of time and
      // `continueCallback` is specified, interrupt the execution.
      if (chunkOperations && ++steps > EXECUTION_STEPS) {
        if (Date.now() > endTime) {
          continueCallback();
          return i;
        }
        steps = 0;
      }

      // If the operatorList isn't executed completely yet OR the execution
      // time was short enough, do another execution round.
    }
  }

  #restoreInitialState() {
    // Finishing all opened operations such as SMask group painting.
    while (this.stateStack.length || this.inSMaskMode) {
      this.restore();
    }

    this.current.activeSMask = null;
    this.ctx.restore();

    if (this.transparentCanvas) {
      this.ctx = this.compositeCtx!;
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0); // Avoid apply transform twice
      this.ctx.drawImage(this.transparentCanvas, 0, 0);
      this.ctx.restore();
      this.transparentCanvas = null;
    }
  }

  endDrawing() {
    this.#restoreInitialState();

    this.cachedCanvases.clear();
    this.cachedPatterns.clear();

    for (const cache of this._cachedBitmapsMap.values()) {
      for (const canvas of cache.values()) {
        if (
          typeof HTMLCanvasElement !== "undefined" &&
          canvas instanceof HTMLCanvasElement
        ) {
          canvas.width = canvas.height = 0;
        }
      }
      cache.clear();
    }
    this._cachedBitmapsMap.clear();
    this.#drawFilter();
  }

  #drawFilter() {
    if (this.pageColors) {
      const hcmFilterId = this.filterFactory.addHCMFilter(
        this.pageColors.foreground,
        this.pageColors.background
      );
      if (hcmFilterId !== "none") {
        const savedFilter = this.ctx.filter;
        this.ctx.filter = hcmFilterId;
        this.ctx.drawImage(this.ctx.canvas, 0, 0);
        this.ctx.filter = savedFilter;
      }
    }
  }

  _scaleImage(img: HTMLCanvasElement | VideoFrame, inverseTransform: TransformType) {
    // Vertical or horizontal scaling shall not be more than 2 to not lose the
    // pixels during drawImage operation, painting on the temporary canvas(es)
    // that are twice smaller in size.

    // displayWidth and displayHeight are used for VideoFrame.
    const width = img instanceof HTMLCanvasElement ? img.width : img.displayWidth;
    const height = img instanceof HTMLCanvasElement ? img.height : img.displayHeight;
    let widthScale = Math.max(
      Math.hypot(inverseTransform[0], inverseTransform[1]),
      1
    );
    let heightScale = Math.max(
      Math.hypot(inverseTransform[2], inverseTransform[3]),
      1
    );

    let paintWidth = width,
      paintHeight = height;
    let tmpCanvasId = "prescale1";
    let tmpCanvas, tmpCtx;
    while (
      (widthScale > 2 && paintWidth > 1) ||
      (heightScale > 2 && paintHeight > 1)
    ) {
      let newWidth = paintWidth,
        newHeight = paintHeight;
      if (widthScale > 2 && paintWidth > 1) {
        // See bug 1820511 (Windows specific bug).
        // TODO: once the above bug is fixed we could revert to:
        // newWidth = Math.ceil(paintWidth / 2);
        newWidth =
          paintWidth >= 16384
            ? Math.floor(paintWidth / 2) - 1 || 1
            : Math.ceil(paintWidth / 2);
        widthScale /= paintWidth / newWidth;
      }
      if (heightScale > 2 && paintHeight > 1) {
        // TODO: see the comment above.
        newHeight =
          paintHeight >= 16384
            ? Math.floor(paintHeight / 2) - 1 || 1
            : Math.ceil(paintHeight) / 2;
        heightScale /= paintHeight / newHeight;
      }
      tmpCanvas = this.cachedCanvases.getCanvas(
        tmpCanvasId,
        newWidth,
        newHeight
      );
      tmpCtx = tmpCanvas.context!;
      tmpCtx.clearRect(0, 0, newWidth, newHeight);
      tmpCtx.drawImage(img, 0, 0, paintWidth, paintHeight, 0, 0, newWidth, newHeight);
      img = tmpCanvas.canvas!;
      paintWidth = newWidth;
      paintHeight = newHeight;
      tmpCanvasId = tmpCanvasId === "prescale1" ? "prescale2" : "prescale1";
    }

    return { img, paintWidth, paintHeight };
  }

  _createMaskCanvas(img: {
    data: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
    interpolate: number[];
    count: number;
    bitmap: CanvasImageSource | null;
  }) {
    const ctx = this.ctx;
    const { width, height } = img;
    const fillColor = this.current.fillColor;
    const isPatternFill = this.current.patternFill;
    const currentTransform = getCurrentTransform(ctx);

    let cache, cacheKey, scaled, maskCanvas;
    if ((img.bitmap || img.data) && img.count > 1) {
      const mainKey = img.bitmap || img.data.buffer;
      // We're reusing the same image several times, so we can cache it.
      // In case we've a pattern fill we just keep the scaled version of
      // the image.
      // Only the scaling part matters, the translation part is just used
      // to compute offsets (but not when filling patterns see #15573).
      // TODO: handle the case of a pattern fill if it's possible.
      cacheKey = JSON.stringify(
        isPatternFill ? currentTransform : [currentTransform.slice(0, 4), fillColor]
      );

      cache = this._cachedBitmapsMap.get(mainKey);
      if (!cache) {
        cache = new Map();
        this._cachedBitmapsMap.set(mainKey, cache);
      }
      const cachedImage = cache.get(cacheKey);
      if (cachedImage && !isPatternFill) {
        const offsetX = Math.round(
          Math.min(currentTransform[0], currentTransform[2]) +
          currentTransform[4]
        );
        const offsetY = Math.round(
          Math.min(currentTransform[1], currentTransform[3]) +
          currentTransform[5]
        );
        return {
          canvas: cachedImage,
          offsetX,
          offsetY,
        };
      }
      scaled = cachedImage;
    }

    if (!scaled) {
      maskCanvas = this.cachedCanvases.getCanvas("maskCanvas", width, height);
      putBinaryImageMask(maskCanvas.context!, img);
    }

    // Create the mask canvas at the size it will be drawn at and also set
    // its transform to match the current transform so if there are any
    // patterns applied they will be applied relative to the correct
    // transform.

    const nt = [1 / width, 0, 0, -1 / height, 0, 0]
    let maskToCanvas = Util.transform(currentTransform, nt);
    maskToCanvas = Util.transform(maskToCanvas, [1, 0, 0, 1, 0, -height]);
    const [minX, minY, maxX, maxY] = Util.getAxialAlignedBoundingBox(
      [0, 0, width, height],
      maskToCanvas
    );
    const drawnWidth = Math.round(maxX - minX) || 1;
    const drawnHeight = Math.round(maxY - minY) || 1;
    const fillCanvas = this.cachedCanvases.getCanvas(
      "fillCanvas",
      drawnWidth,
      drawnHeight
    );
    const fillCtx = fillCanvas.context!;

    // The offset will be the top-left cordinate mask.
    // If objToCanvas is [a,b,c,d,e,f] then:
    //   - offsetX = min(a, c) + e
    //   - offsetY = min(b, d) + f
    const offsetX = minX;
    const offsetY = minY;
    fillCtx.translate(-offsetX, -offsetY);
    fillCtx.transform(...maskToCanvas);

    if (!scaled) {
      // Pre-scale if needed to improve image smoothing.
      scaled = this._scaleImage(
        maskCanvas!.canvas!,
        getCurrentTransformInverse(fillCtx)
      );
      scaled = scaled.img;
      if (cache && isPatternFill) {
        cache.set(cacheKey, scaled);
      }
    }

    fillCtx.imageSmoothingEnabled = getImageSmoothingEnabled(
      getCurrentTransform(fillCtx),
      img.interpolate
    );

    drawImageAtIntegerCoords(
      fillCtx, scaled, 0, 0, scaled.width, scaled.height, 0, 0, width, height
    );
    fillCtx.globalCompositeOperation = "source-in";

    const inverse = Util.transform(
      getCurrentTransformInverse(fillCtx), [1, 0, 0, 1, -offsetX, -offsetY]
    );
    fillCtx.fillStyle = isPatternFill
      ? (fillColor as BaseShadingPattern | TilingPattern).getPattern(ctx, this, inverse, PathType.FILL)
      : <string>fillColor;

    fillCtx.fillRect(0, 0, width, height);

    if (cache && !isPatternFill) {
      // The fill canvas is put in the cache associated to the mask image
      // so we must remove from the cached canvas: it mustn't be used again.
      this.cachedCanvases.delete("fillCanvas");
      cache.set(cacheKey, fillCanvas.canvas);
    }

    // Round the offsets to avoid drawing fractional pixels.
    return {
      canvas: fillCanvas.canvas,
      offsetX: Math.round(offsetX),
      offsetY: Math.round(offsetY),
    };
  }

  // Graphics state
  @handle(OPS.setLineWidth)
  setLineWidth(width: number) {
    if (width !== this.current.lineWidth) {
      this._cachedScaleForStroking[0] = -1;
    }
    this.current.lineWidth = width;
    this.ctx.lineWidth = width;
  }

  @handle(OPS.setLineCap)
  setLineCap(style: number) {
    this.ctx.lineCap = LINE_CAP_STYLES[style];
  }

  @handle(OPS.setLineJoin)
  setLineJoin(style: number) {
    this.ctx.lineJoin = LINE_JOIN_STYLES[style];
  }

  @handle(OPS.setMiterLimit)
  setMiterLimit(limit: number) {
    this.ctx.miterLimit = limit;
  }

  @handle(OPS.setDash)
  setDash(dashArray: number[], dashPhase: number) {
    const ctx = this.ctx;
    if (ctx.setLineDash !== undefined) {
      ctx.setLineDash(dashArray);
      ctx.lineDashOffset = dashPhase;
    }
  }

  @handle(OPS.setRenderingIntent)
  setRenderingIntent(_intent: unknown) {
    // This operation is ignored since we haven't found a use case for it yet.
  }

  @handle(OPS.setFlatness)
  setFlatness(_flatness: unknown) {
    // This operation is ignored since we haven't found a use case for it yet.
  }

  @handle(OPS.setGState)
  setGState(states: [DictKey, unknown][]) {
    for (const [key, value] of states) {
      switch (key) {
        case DictKey.LW:
          this.setLineWidth(<number>value);
          break;
        case DictKey.LC:
          this.setLineCap(<number>value);
          break;
        case DictKey.LJ:
          this.setLineJoin(<number>value);
          break;
        case DictKey.ML:
          this.setMiterLimit(<number>value);
          break;
        case DictKey.D:
          this.setDash((<[number[], number]>value)[0], (<[number[], number]>value)[1]);
          break;
        case DictKey.RI:
          this.setRenderingIntent(value);
          break;
        case DictKey.FL:
          this.setFlatness(value);
          break;
        case DictKey.Font:
          this.setFont((<[string, number]>value)[0], (<[string, number]>value)[1]);
          break;
        case DictKey.CA:
          this.current.strokeAlpha = <number>value;
          break;
        case DictKey.ca:
          this.current.fillAlpha = <number>value;
          this.ctx.globalAlpha = <number>value;
          break;
        case DictKey.BM:
          this.ctx.globalCompositeOperation = <GlobalCompositeOperation>value;
          break;
        case DictKey.SMask:
          this.current.activeSMask = value ? this.tempSMask : null;
          this.tempSMask = null;
          this.checkSMaskState();
          break;
        case DictKey.TR:
          this.ctx.filter = this.current.transferMaps =
            this.filterFactory.addFilter(<Uint8Array<ArrayBuffer>>value);
          break;
      }
    }
  }

  get inSMaskMode() {
    return !!this.suspendedCtx;
  }

  checkSMaskState() {
    const inSMaskMode = this.inSMaskMode;
    if (this.current.activeSMask && !inSMaskMode) {
      this.beginSMaskMode();
    } else if (!this.current.activeSMask && inSMaskMode) {
      this.endSMaskMode();
    }
    // Else, the state is okay and nothing needs to be done.
  }

  /**
   * Soft mask mode takes the current main drawing canvas and replaces it with
   * a temporary canvas. Any drawing operations that happen on the temporary
   * canvas need to be composed with the main canvas that was suspended (see
   * `compose()`). The temporary canvas also duplicates many of its operations
   * on the suspended canvas to keep them in sync, so that when the soft mask
   * mode ends any clipping paths or transformations will still be active and in
   * the right order on the canvas' graphics state stack.
   */
  beginSMaskMode() {
    if (this.inSMaskMode) {
      throw new Error("beginSMaskMode called while already in smask mode");
    }
    const drawnWidth = this.ctx.canvas.width;
    const drawnHeight = this.ctx.canvas.height;
    const cacheId = "smaskGroupAt" + this.groupLevel;
    const scratchCanvas = this.cachedCanvases.getCanvas(
      cacheId,
      drawnWidth,
      drawnHeight
    );
    this.suspendedCtx = this.ctx!;
    this.ctx = scratchCanvas.context!;
    const ctx = this.ctx;
    ctx.setTransform(...getCurrentTransform(this.suspendedCtx));
    copyCtxState(this.suspendedCtx, ctx);
    mirrorContextOperations(ctx, this.suspendedCtx);

    this.setGState([[DictKey.BM, "source-over"], [DictKey.ca, 1], [DictKey.CA, 1]]);
  }

  endSMaskMode() {
    if (!this.inSMaskMode) {
      throw new Error("endSMaskMode called while not in smask mode");
    }
    // The soft mask is done, now restore the suspended canvas as the main
    // drawing canvas.
    this.ctx._removeMirroring?.();
    copyCtxState(this.ctx, this.suspendedCtx!);
    this.ctx = this.suspendedCtx!;

    this.suspendedCtx = null;
  }

  compose(dirtyBox: RectType | null = null) {
    if (!this.current.activeSMask) {
      return;
    }

    if (!dirtyBox) {
      dirtyBox = [0, 0, this.ctx.canvas.width, this.ctx.canvas.height];
    } else {
      dirtyBox[0] = Math.floor(dirtyBox[0]);
      dirtyBox[1] = Math.floor(dirtyBox[1]);
      dirtyBox[2] = Math.ceil(dirtyBox[2]);
      dirtyBox[3] = Math.ceil(dirtyBox[3]);
    }
    const smask = this.current.activeSMask;
    const suspendedCtx = this.suspendedCtx!;

    this.composeSMask(suspendedCtx, smask, this.ctx, dirtyBox);
    // Whatever was drawn has been moved to the suspended canvas, now clear it
    // out of the current canvas.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    this.ctx.restore();
  }

  composeSMask(
    ctx: CanvasRenderingContext2D,
    smask: GroupSMask,
    layerCtx: CanvasRenderingContext2D,
    layerBox: RectType
  ) {
    const layerOffsetX = layerBox[0];
    const layerOffsetY = layerBox[1];
    const layerWidth = layerBox[2] - layerOffsetX;
    const layerHeight = layerBox[3] - layerOffsetY;
    if (layerWidth === 0 || layerHeight === 0) {
      return;
    }
    this.genericComposeSMask(
      smask.context,
      layerCtx,
      layerWidth,
      layerHeight,
      smask.subtype,
      smask.backdrop,
      smask.transferMap,
      layerOffsetX,
      layerOffsetY,
      smask.offsetX,
      smask.offsetY
    );
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layerCtx.canvas, 0, 0);
    ctx.restore();
  }

  genericComposeSMask(
    maskCtx: CanvasRenderingContext2D,
    layerCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    subtype: string,
    backdrop: number[] | Uint8ClampedArray<ArrayBuffer>,
    transferMap: Uint8Array<ArrayBuffer> | null,
    layerOffsetX: number,
    layerOffsetY: number,
    maskOffsetX: number,
    maskOffsetY: number
  ) {
    let maskCanvas = maskCtx.canvas;
    let maskX = layerOffsetX - maskOffsetX;
    let maskY = layerOffsetY - maskOffsetY;

    if (backdrop) {
      const backdropRGB = Util.makeHexColor(...<RGBType>backdrop);
      if (
        maskX < 0 ||
        maskY < 0 ||
        maskX + width > maskCanvas.width ||
        maskY + height > maskCanvas.height
      ) {
        const canvas = this.cachedCanvases.getCanvas(
          "maskExtension",
          width,
          height
        );
        const ctx = canvas.context!;
        ctx.drawImage(maskCanvas, -maskX, -maskY);
        ctx.globalCompositeOperation = "destination-atop";
        ctx.fillStyle = backdropRGB;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = "source-over";

        maskCanvas = canvas.canvas!;
        maskX = maskY = 0;
      } else {
        maskCtx.save();
        maskCtx.globalAlpha = 1;
        maskCtx.setTransform(1, 0, 0, 1, 0, 0);
        const clip = new Path2D();
        clip.rect(maskX, maskY, width, height);
        maskCtx.clip(clip);
        maskCtx.globalCompositeOperation = "destination-atop";
        maskCtx.fillStyle = backdropRGB;
        maskCtx.fillRect(maskX, maskY, width, height);
        maskCtx.restore();
      }
    }

    layerCtx.save();
    layerCtx.globalAlpha = 1;
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);

    if (subtype === "Alpha" && transferMap) {
      layerCtx.filter = this.filterFactory.addAlphaFilter(transferMap);
    } else if (subtype === "Luminosity") {
      layerCtx.filter = this.filterFactory.addLuminosityFilter(transferMap);
    }

    const clip = new Path2D();
    clip.rect(layerOffsetX, layerOffsetY, width, height);
    layerCtx.clip(clip);
    layerCtx.globalCompositeOperation = "destination-in";
    layerCtx.drawImage(
      maskCanvas, maskX, maskY, width, height, layerOffsetX, layerOffsetY, width, height
    );
    layerCtx.restore();
  }

  @handle(OPS.save)
  save() {
    if (this.inSMaskMode) {
      // SMask mode may be turned on/off causing us to lose graphics state.
      // Copy the temporary canvas state to the main(suspended) canvas to keep
      // it in sync.
      copyCtxState(this.ctx, this.suspendedCtx!);
      // Don't bother calling save on the temporary canvas since state is not
      // saved there.
      this.suspendedCtx!.save();
    } else {
      this.ctx.save();
    }
    const old = this.current;
    this.stateStack.push(old);
    this.current = old.clone();
  }

  @handle(OPS.restore)
  restore() {
    if (this.stateStack.length === 0 && this.inSMaskMode) {
      this.endSMaskMode();
    }
    if (this.stateStack.length !== 0) {
      this.current = this.stateStack.pop()!;
      if (this.inSMaskMode) {
        // Graphics state is stored on the main(suspended) canvas. Restore its
        // state then copy it over to the temporary canvas.
        this.suspendedCtx!.restore();
        copyCtxState(this.suspendedCtx!, this.ctx);
      } else {
        this.ctx.restore();
      }
      this.checkSMaskState();

      // Ensure that the clipping path is reset (fixes issue6413.pdf).
      this.pendingClip = null;

      this._cachedScaleForStroking[0] = -1;
      this._cachedGetSinglePixelWidth = null;
    }
  }

  @handle(OPS.transform)
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.ctx.transform(a, b, c, d, e, f);

    this._cachedScaleForStroking[0] = -1;
    this._cachedGetSinglePixelWidth = null;
  }

  // Path
  @handle(OPS.constructPath)
  constructPath(ops: OPS[], args: number[], minMax: RectType) {
    const ctx = this.ctx;
    const current = this.current;
    let x = current.x;
    let y = current.y;
    let startX, startY;
    const currentTransform = getCurrentTransform(ctx);

    // Most of the time the current transform is a scaling matrix
    // so we don't need to transform points before computing min/max:
    // we can compute min/max first and then smartly "apply" the
    // transform (see Util.scaleMinMax).
    // For rectangle, moveTo and lineTo, min/max are computed in the
    // worker (see evaluator.js).
    const isScalingMatrix = (currentTransform[0] === 0 && currentTransform[3] === 0) ||
      (currentTransform[1] === 0 && currentTransform[2] === 0);
    const minMaxForBezier = isScalingMatrix ? <RectType>minMax.slice(0) : null;

    for (let i = 0, j = 0, ii = ops.length; i < ii; i++) {
      switch (ops[i] | 0) {
        case OPS.rectangle:
          x = args[j++];
          y = args[j++];
          const width = args[j++];
          const height = args[j++];

          const xw = x + width;
          const yh = y + height;
          ctx.moveTo(x, y);
          if (width === 0 || height === 0) {
            ctx.lineTo(xw, yh);
          } else {
            ctx.lineTo(xw, y);
            ctx.lineTo(xw, yh);
            ctx.lineTo(x, yh);
          }
          if (!isScalingMatrix) {
            current.updateRectMinMax(currentTransform, [x, y, xw, yh]);
          }
          ctx.closePath();
          break;
        case OPS.moveTo:
          x = args[j++];
          y = args[j++];
          ctx.moveTo(x, y);
          if (!isScalingMatrix) {
            current.updatePathMinMax(currentTransform, x, y);
          }
          break;
        case OPS.lineTo:
          x = args[j++];
          y = args[j++];
          ctx.lineTo(x, y);
          if (!isScalingMatrix) {
            current.updatePathMinMax(currentTransform, x, y);
          }
          break;
        case OPS.curveTo:
          startX = x;
          startY = y;
          x = args[j + 4];
          y = args[j + 5];
          ctx.bezierCurveTo(
            args[j], args[j + 1], args[j + 2], args[j + 3], x, y
          );
          current.updateCurvePathMinMax(
            currentTransform, startX, startY, args[j], args[j + 1],
            args[j + 2], args[j + 3], x, y, minMaxForBezier
          );
          j += 6;
          break;
        case OPS.curveTo2:
          startX = x;
          startY = y;
          ctx.bezierCurveTo(
            x, y, args[j], args[j + 1], args[j + 2], args[j + 3]
          );
          current.updateCurvePathMinMax(
            currentTransform, startX, startY, x, y,
            args[j], args[j + 1], args[j + 2], args[j + 3], minMaxForBezier
          );
          x = args[j + 2];
          y = args[j + 3];
          j += 4;
          break;
        case OPS.curveTo3:
          startX = x;
          startY = y;
          x = args[j + 2];
          y = args[j + 3];
          ctx.bezierCurveTo(args[j], args[j + 1], x, y, x, y);
          current.updateCurvePathMinMax(
            currentTransform, startX, startY, args[j], args[j + 1],
            x, y, x, y, minMaxForBezier
          );
          j += 4;
          break;
        case OPS.closePath:
          ctx.closePath();
          break;
      }
    }

    if (isScalingMatrix) {
      current.updateScalingPathMinMax(currentTransform, minMaxForBezier!);
    }

    current.setCurrentPoint(x, y);
  }

  @handle(OPS.closePath)
  closePath() {
    this.ctx.closePath();
  }

  @handle(OPS.stroke)
  stroke(consumePath = true) {
    const ctx = this.ctx;
    const strokeColor = this.current.strokeColor;
    // For stroke we want to temporarily change the global alpha to the
    // stroking alpha.
    ctx.globalAlpha = this.current.strokeAlpha;
    if (this.contentVisible) {
      if (typeof strokeColor === "object" && strokeColor?.getPattern) {
        ctx.save();
        ctx.strokeStyle = strokeColor.getPattern(
          ctx,
          this,
          getCurrentTransformInverse(ctx),
          PathType.STROKE
        );
        this.rescaleAndStroke(/* saveRestore */ false);
        ctx.restore();
      } else {
        this.rescaleAndStroke(/* saveRestore */ true);
      }
    }
    if (consumePath) {
      this.consumePath(this.current.getClippedPathBoundingBox());
    }
    // Restore the global alpha to the fill alpha
    ctx.globalAlpha = this.current.fillAlpha;
  }

  @handle(OPS.closeStroke)
  closeStroke() {
    this.closePath();
    this.stroke();
  }

  @handle(OPS.fill)
  fill(consumePath = true) {
    const ctx = this.ctx;
    const fillColor = this.current.fillColor;
    const isPatternFill = this.current.patternFill;
    let needRestore = false;

    if (isPatternFill) {
      ctx.save();
      ctx.fillStyle = (fillColor as BaseShadingPattern | TilingPattern).getPattern(
        ctx,
        this,
        getCurrentTransformInverse(ctx),
        PathType.FILL
      );
      needRestore = true;
    }

    const intersect = this.current.getClippedPathBoundingBox();
    if (this.contentVisible && intersect !== null) {
      if (this.pendingEOFill) {
        ctx.fill("evenodd");
        this.pendingEOFill = false;
      } else {
        ctx.fill();
      }
    }

    if (needRestore) {
      ctx.restore();
    }
    if (consumePath) {
      this.consumePath(intersect);
    }
  }

  @handle(OPS.eoFill)
  eoFill() {
    this.pendingEOFill = true;
    this.fill();
  }

  @handle(OPS.fillStroke)
  fillStroke() {
    this.fill(false);
    this.stroke(false);

    this.consumePath();
  }

  @handle(OPS.eoFillStroke)
  eoFillStroke() {
    this.pendingEOFill = true;
    this.fillStroke();
  }

  @handle(OPS.closeFillStroke)
  closeFillStroke() {
    this.closePath();
    this.fillStroke();
  }

  @handle(OPS.closeEOFillStroke)
  closeEOFillStroke() {
    this.pendingEOFill = true;
    this.closePath();
    this.fillStroke();
  }

  @handle(OPS.endPath)
  endPath() {
    this.consumePath();
  }

  // Clipping
  @handle(OPS.clip)
  clip() {
    this.pendingClip = NORMAL_CLIP;
  }

  @handle(OPS.eoClip)
  eoClip() {
    this.pendingClip = EO_CLIP;
  }

  // Text
  @handle(OPS.beginText)
  beginText() {
    this.current.textMatrix = IDENTITY_MATRIX;
    this.current.textMatrixScale = 1;
    this.current.x = this.current.lineX = 0;
    this.current.y = this.current.lineY = 0;
  }

  @handle(OPS.endText)
  endText() {
    const paths = this.pendingTextPaths!;
    const ctx = this.ctx;
    if (isNull(paths)) {
      ctx.beginPath();
      return;
    }

    ctx.save();
    ctx.beginPath();
    for (const path of paths) {
      ctx.setTransform(...path.transform);
      ctx.translate(path.x, path.y);
      path.addToPath?.(ctx, path.fontSize);
    }
    ctx.restore();
    ctx.clip();
    ctx.beginPath();
    // delete this.pendingTextPaths;
    this.pendingTextPaths = null;
  }

  @handle(OPS.setCharSpacing)
  setCharSpacing(spacing: number) {
    this.current.charSpacing = spacing;
  }

  @handle(OPS.setWordSpacing)
  setWordSpacing(spacing: number) {
    this.current.wordSpacing = spacing;
  }

  @handle(OPS.setHScale)
  setHScale(scale: number) {
    this.current.textHScale = scale / 100;
  }

  @handle(OPS.setLeading)
  setLeading(leading: number) {
    this.current.leading = -leading;
  }

  @handle(OPS.setFont)
  setFont(fontRefName: string, size: number) {
    const fontObj = <FontFaceObject>this.commonObjs.get(fontRefName);
    const fontProps = fontObj.getProps();
    const current = this.current;

    if (!fontObj) {
      throw new Error(`Can't find font for ${fontRefName}`);
    }
    current.fontMatrix = fontProps.fontMatrix || FONT_IDENTITY_MATRIX;

    // A valid matrix needs all main diagonal elements to be non-zero
    // This also ensures we bypass FF bugzilla bug #719844.
    if (current.fontMatrix[0] === 0 || current.fontMatrix[3] === 0) {
      warn("Invalid font matrix for font " + fontRefName);
    }

    // The spec for Tf (setFont) says that 'size' specifies the font 'scale',
    // and in some docs this can be negative (inverted x-y axes).
    if (size < 0) {
      size = -size;
      current.fontDirection = -1;
    } else {
      current.fontDirection = 1;
    }

    this.current.font = fontObj;
    this.current.fontSize = size;

    if (fontProps.isType3Font) {
      return; // we don't need ctx.font for Type3 fonts
    }

    const name = fontProps.loadedName || "sans-serif";
    const typeface = fontProps.systemFontInfo?.css || `"${name}", ${fontProps.fallbackName}`;

    let bold = "normal";
    if (fontProps.black) {
      bold = "900";
    } else if (fontProps.bold) {
      bold = "bold";
    }
    const italic = fontProps.italic ? "italic" : "normal";

    // Some font backends cannot handle fonts below certain size.
    // Keeping the font at minimal size and using the fontSizeScale to change
    // the current transformation matrix before the fillText/strokeText.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=726227
    let browserFontSize = size;
    if (size < MIN_FONT_SIZE) {
      browserFontSize = MIN_FONT_SIZE;
    } else if (size > MAX_FONT_SIZE) {
      browserFontSize = MAX_FONT_SIZE;
    }
    this.current.fontSizeScale = size / browserFontSize;

    this.ctx.font = `${italic} ${bold} ${browserFontSize}px ${typeface}`;
  }

  @handle(OPS.setTextRenderingMode)
  setTextRenderingMode(mode: number) {
    this.current.textRenderingMode = mode;
  }

  @handle(OPS.setTextRise)
  setTextRise(rise: number) {
    this.current.textRise = rise;
  }

  @handle(OPS.moveText)
  moveText(x: number, y: number) {
    this.current.x = this.current.lineX += x;
    this.current.y = this.current.lineY += y;
  }

  @handle(OPS.setLeadingMoveText)
  setLeadingMoveText(x: number, y: number) {
    this.setLeading(-y);
    this.moveText(x, y);
  }

  @handle(OPS.setTextMatrix)
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.current.textMatrix = [a, b, c, d, e, f];
    this.current.textMatrixScale = Math.hypot(a, b);

    this.current.x = this.current.lineX = 0;
    this.current.y = this.current.lineY = 0;
  }

  @handle(OPS.nextLine)
  nextLine() {
    this.moveText(0, this.current.leading);
  }

  paintChar(character: string, x: number, y: number, patternTransform: TransformType) {
    const ctx = this.ctx;
    const current = this.current;
    const font = <FontFaceObject>current.font;
    const textRenderingMode = current.textRenderingMode;
    const fontSize = current.fontSize / current.fontSizeScale;
    const fillStrokeMode =
      textRenderingMode & TextRenderingMode.FILL_STROKE_MASK;
    const isAddToPathSet = !!(
      textRenderingMode & TextRenderingMode.ADD_TO_PATH_FLAG
    );
    const patternFill = current.patternFill && !font.translated.missingFile;

    let addToPath = null;
    if (font.disableFontFace || isAddToPathSet || patternFill) {
      addToPath = font.getPathGenerator(this.commonObjs, character);
    }

    if (font.disableFontFace || patternFill) {
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      addToPath!(ctx, fontSize);
      if (patternTransform) {
        ctx.setTransform(...patternTransform);
      }
      if (
        fillStrokeMode === TextRenderingMode.FILL ||
        fillStrokeMode === TextRenderingMode.FILL_STROKE
      ) {
        ctx.fill();
      }
      if (
        fillStrokeMode === TextRenderingMode.STROKE ||
        fillStrokeMode === TextRenderingMode.FILL_STROKE
      ) {
        ctx.stroke();
      }
      ctx.restore();
    } else {
      if (
        fillStrokeMode === TextRenderingMode.FILL ||
        fillStrokeMode === TextRenderingMode.FILL_STROKE
      ) {
        ctx.fillText(character, x, y);
      }
      if (
        fillStrokeMode === TextRenderingMode.STROKE ||
        fillStrokeMode === TextRenderingMode.FILL_STROKE
      ) {
        ctx.strokeText(character, x, y);
      }
    }

    if (isAddToPathSet) {
      const paths = (this.pendingTextPaths ||= []);
      paths.push({
        transform: getCurrentTransform(ctx),
        x,
        y,
        fontSize,
        addToPath,
      });
    }
  }

  get isFontSubpixelAAEnabled() {
    // Checks if anti-aliasing is enabled when scaled text is painted.
    // On Windows GDI scaled fonts looks bad.
    const { context: ctx } = this.cachedCanvases.getCanvas(
      "isFontSubpixelAAEnabled", 10, 10
    );
    ctx!.scale(1.5, 1);
    ctx!.fillText("I", 0, 10);
    const data = ctx!.getImageData(0, 0, 10, 10).data;
    let enabled = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0 && data[i] < 255) {
        enabled = true;
        break;
      }
    }
    return shadow(this, "isFontSubpixelAAEnabled", enabled);
  }

  // 猜测是(numbler| Glyph)，调试时发现确实是这个值
  @handle(OPS.showText)
  showText(glyphs: (number | Glyph)[]) {
    const current = this.current;
    const font = current.font;
    assertNotNull(font);
    const fontProps = font.getProps();
    if (fontProps.isType3Font) {
      return this.showType3Text(<Glyph[]>glyphs);
    }

    const fontSize = current.fontSize;
    if (fontSize === 0) {
      return undefined;
    }

    const ctx = this.ctx;
    const fontSizeScale = current.fontSizeScale;
    const charSpacing = current.charSpacing;
    const wordSpacing = current.wordSpacing;
    const fontDirection = current.fontDirection!;
    const textHScale = current.textHScale * fontDirection;
    const glyphsLength = glyphs.length;
    const vertical = fontProps.vertical;
    const spacingDir = vertical ? 1 : -1;
    const defaultVMetrics = fontProps.defaultVMetrics!;
    const widthAdvanceScale = fontSize * current.fontMatrix[0];

    const simpleFillText =
      current.textRenderingMode === TextRenderingMode.FILL &&
      !font.disableFontFace &&
      !current.patternFill;

    ctx.save();
    ctx.transform(...<TransformType>current.textMatrix);
    ctx.translate(current.x, current.y + current.textRise);

    if (fontDirection > 0) {
      ctx.scale(textHScale, -1);
    } else {
      ctx.scale(textHScale, 1);
    }

    let patternTransform;
    if (current.patternFill) {
      ctx.save();
      const pattern = (<BaseShadingPattern | TilingPattern>current.fillColor).getPattern(
        ctx, this, getCurrentTransformInverse(ctx), PathType.FILL
      );
      patternTransform = getCurrentTransform(ctx);
      ctx.restore();
      ctx.fillStyle = pattern;
    }

    let lineWidth = current.lineWidth;
    const scale = current.textMatrixScale;
    if (scale === 0 || lineWidth === 0) {
      const fillStrokeMode =
        current.textRenderingMode & TextRenderingMode.FILL_STROKE_MASK;
      if (
        fillStrokeMode === TextRenderingMode.STROKE ||
        fillStrokeMode === TextRenderingMode.FILL_STROKE
      ) {
        lineWidth = this.getSinglePixelWidth();
      }
    } else {
      lineWidth /= scale;
    }

    if (fontSizeScale !== 1.0) {
      ctx.scale(fontSizeScale, fontSizeScale);
      lineWidth /= fontSizeScale;
    }

    ctx.lineWidth = lineWidth;

    if (fontProps.isInvalidPDFjsFont) {
      const chars = [];
      let width = 0;
      for (const glyph of glyphs) {
        chars.push((<Glyph>glyph).unicode);
        width += (<Glyph>glyph).width;
      }
      ctx.fillText(chars.join(""), 0, 0);
      current.x += width * widthAdvanceScale * textHScale;
      ctx.restore();
      this.compose();

      return undefined;
    }

    let x = 0, i;
    for (i = 0; i < glyphsLength; ++i) {
      const glyph = glyphs[i];
      if (typeof glyph === "number") {
        x += (spacingDir * glyph * fontSize) / 1000;
        continue;
      }

      let restoreNeeded = false;
      const spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
      const character = glyph.fontChar;
      const accent = glyph.accent;
      let scaledX, scaledY;
      let width = glyph.width;
      if (vertical) {
        const vmetric = glyph.vmetric || defaultVMetrics;
        const vx =
          -(glyph.vmetric ? vmetric[1] : width * 0.5) * widthAdvanceScale;
        const vy = vmetric[2] * widthAdvanceScale;

        width = vmetric ? -vmetric[0] : width;
        scaledX = vx / fontSizeScale;
        scaledY = (x + vy) / fontSizeScale;
      } else {
        scaledX = x / fontSizeScale;
        scaledY = 0;
      }

      if (fontProps.remeasure && width > 0) {
        // Some standard fonts may not have the exact width: rescale per
        // character if measured width is greater than expected glyph width
        // and subpixel-aa is enabled, otherwise just center the glyph.
        const measuredWidth =
          ((ctx.measureText(character).width * 1000) / fontSize) *
          fontSizeScale;
        if (width < measuredWidth && this.isFontSubpixelAAEnabled) {
          const characterScaleX = width / measuredWidth;
          restoreNeeded = true;
          ctx.save();
          ctx.scale(characterScaleX, 1);
          scaledX /= characterScaleX;
        } else if (width !== measuredWidth) {
          scaledX +=
            (((width - measuredWidth) / 2000) * fontSize) / fontSizeScale;
        }
      }

      // Only attempt to draw the glyph if it is actually in the embedded font
      // file or if there isn't a font file so the fallback font is shown.
      if (this.contentVisible && (glyph.isInFont || fontProps.missingFile)) {
        if (simpleFillText && !accent) {
          // common case
          ctx.fillText(character, scaledX, scaledY);
        } else {
          this.paintChar(character, scaledX, scaledY, patternTransform!);
          if (accent) {
            const scaledAccentX =
              scaledX + (fontSize * accent.offset.x) / fontSizeScale;
            const scaledAccentY =
              scaledY - (fontSize * accent.offset.y) / fontSizeScale;
            this.paintChar(
              accent.fontChar,
              scaledAccentX,
              scaledAccentY,
              patternTransform!
            );
          }
        }
      }

      const charWidth = vertical ? width * widthAdvanceScale - spacing * fontDirection
        : width * widthAdvanceScale + spacing * fontDirection;
      x += charWidth;

      if (restoreNeeded) {
        ctx.restore();
      }
    }
    if (vertical) {
      current.y -= x;
    } else {
      current.x += x * textHScale;
    }
    ctx.restore();
    this.compose();

    return undefined;
  }

  showType3Text(glyphs: Glyph[]) {
    // Type3 fonts - each glyph is a "mini-PDF"
    const ctx = this.ctx;
    const current = this.current;
    const font = current.font;
    assertNotNull(font);
    const fontProp = font.getProps();
    const fontSize = current.fontSize;
    const fontDirection = current.fontDirection!;
    const spacingDir = fontProp.vertical ? 1 : -1;
    const charSpacing = current.charSpacing;
    const wordSpacing = current.wordSpacing;
    const textHScale = current.textHScale * fontDirection;
    const fontMatrix = current.fontMatrix || FONT_IDENTITY_MATRIX;
    const glyphsLength = glyphs.length;
    const isTextInvisible =
      current.textRenderingMode === TextRenderingMode.INVISIBLE;
    let i, glyph, width, spacingLength;

    if (isTextInvisible || fontSize === 0) {
      return;
    }
    this._cachedScaleForStroking[0] = -1;
    this._cachedGetSinglePixelWidth = null;

    ctx.save();
    ctx.transform(...current.textMatrix);
    ctx.translate(current.x, current.y);

    ctx.scale(textHScale, fontDirection);

    for (i = 0; i < glyphsLength; ++i) {
      glyph = glyphs[i];
      if (typeof glyph === "number") {
        spacingLength = (spacingDir * glyph * fontSize) / 1000;
        this.ctx.translate(spacingLength, 0);
        current.x += spacingLength * textHScale;
        continue;
      }

      const spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
      // 此处代码可能有BUG，因为charProcOpertorList的参数都是string，此处却用number来取，可能存在问题。
      const operatorList = fontProp.charProcOperatorList!.get(<DictKey><unknown>glyph.operatorListId);
      if (!operatorList) {
        warn(`Type3 character "${glyph.operatorListId}" is not available.`);
        continue;
      }
      if (this.contentVisible) {
        this.processingType3 = glyph;
        this.save();
        ctx.scale(fontSize, fontSize);
        ctx.transform(...fontMatrix);
        this.executeOperatorList(operatorList);
        this.restore();
      }

      const transformed = Util.applyTransform([glyph.width, 0], fontMatrix);
      width = transformed[0] * fontSize + spacing;

      ctx.translate(width, 0);
      current.x += width * textHScale;
    }
    ctx.restore();
    this.processingType3 = null;
  }

  // Type3 fonts
  @handle(OPS.setCharWidth)
  setCharWidth(_xWidth: unknown, _yWidth: unknown) {
    // We can safely ignore this since the width should be the same
    // as the width in the Widths array.
  }

  @handle(OPS.setCharWidthAndBounds)
  setCharWidthAndBounds(_xWidth: unknown, _yWidth: unknown, llx: number, lly: number, urx: number, ury: number) {
    this.ctx.rect(llx, lly, urx - llx, ury - lly);
    this.ctx.clip();
    this.endPath();
  }

  // Color
  getColorN_Pattern(IR: TilingPatternIR): TilingPattern | BaseShadingPattern {
    let pattern;
    if (IR[0] === "TilingPattern") {
      const color = IR[1]!;
      const baseTransform = this.baseTransform || getCurrentTransform(this.ctx);
      const canvasGraphicsFactory: CanvasGraphicsFactory = {
        createCanvasGraphics: (ctx: CanvasRenderingContext2D) =>
          new CanvasGraphics(
            ctx,
            this.commonObjs,
            this.objs,
            this.canvasFactory,
            this.filterFactory,
            this.optionalContentConfig,
            this.markedContentStack,
          ),
      };
      pattern = new TilingPattern(
        IR,
        color,
        this.ctx,
        canvasGraphicsFactory,
        baseTransform
      );
    } else {
      pattern = this._getPattern(IR[1]!, IR[3]);
    }
    return pattern;
  }

  @handle(OPS.setStrokeColorN)
  setStrokeColorN(IR: TilingPatternIR) {
    this.current.strokeColor = this.getColorN_Pattern(IR);
  }

  @handle(OPS.setFillColorN)
  setFillColorN(IR: TilingPatternIR) {
    this.current.fillColor = this.getColorN_Pattern(IR);
    this.current.patternFill = true;
  }

  @handle(OPS.setStrokeRGBColor)
  setStrokeRGBColor(r: number, g: number, b: number) {
    this.ctx.strokeStyle = this.current.strokeColor = Util.makeHexColor(r, g, b);
  }

  @handle(OPS.setStrokeTransparent)
  setStrokeTransparent() {
    this.ctx.strokeStyle = this.current.strokeColor = "transparent";
  }

  @handle(OPS.setFillRGBColor)
  setFillRGBColor(r: number, g: number, b: number) {
    this.ctx.fillStyle = this.current.fillColor = Util.makeHexColor(r, g, b);
    this.current.patternFill = false;
  }

  @handle(OPS.setFillTransparent)
  setFillTransparent() {
    this.ctx.fillStyle = this.current.fillColor = "transparent";
    this.current.patternFill = false;
  }

  _getPattern(objId: string | Uint8ClampedArray<ArrayBuffer>, matrix: TransformType | null = null): BaseShadingPattern {
    let pattern: BaseShadingPattern;
    if (this.cachedPatterns.has(objId)) {
      pattern = this.cachedPatterns.get(objId)!;
    } else {
      pattern = getShadingPattern(this.getObject(objId));
      this.cachedPatterns.set(objId, pattern);
    }
    if (matrix) {
      pattern!.matrix = matrix;
    }
    return pattern;
  }

  @handle(OPS.shadingFill)
  shadingFill(objId: string) {
    if (!this.contentVisible) {
      return;
    }
    const ctx = this.ctx;

    this.save();
    const pattern = this._getPattern(objId);
    ctx.fillStyle = pattern.getPattern(
      ctx,
      this,
      getCurrentTransformInverse(ctx),
      PathType.SHADING
    );

    const inv = getCurrentTransformInverse(ctx);
    if (inv) {
      const { width, height } = ctx.canvas;
      const [x0, y0, x1, y1] = Util.getAxialAlignedBoundingBox(
        [0, 0, width, height],
        inv
      );

      this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      // HACK to draw the gradient onto an infinite rectangle.
      // PDF gradients are drawn across the entire image while
      // Canvas only allows gradients to be drawn in a rectangle
      // The following bug should allow us to remove this.
      // https://bugzilla.mozilla.org/show_bug.cgi?id=664884

      this.ctx.fillRect(-1e10, -1e10, 2e10, 2e10);
    }

    this.compose(this.current.getClippedPathBoundingBox());
    this.restore();
  }

  // Images
  @handle(OPS.beginInlineImage)
  beginInlineImage() {
    unreachable("Should not call beginInlineImage");
  }

  @handle(OPS.beginImageData)
  beginImageData() {
    unreachable("Should not call beginImageData");
  }

  @handle(OPS.paintFormXObjectBegin)
  paintFormXObjectBegin(matrix: TransformType | null, bbox: RectType | null) {
    if (!this.contentVisible) {
      return;
    }
    this.save();
    this.baseTransformStack.push(this.baseTransform);

    if (matrix) {
      this.transform(...matrix);
    }
    this.baseTransform = getCurrentTransform(this.ctx);

    if (bbox) {
      const width = bbox[2] - bbox[0];
      const height = bbox[3] - bbox[1];
      this.ctx.rect(bbox[0], bbox[1], width, height);
      this.current.updateRectMinMax(getCurrentTransform(this.ctx), bbox);
      this.clip();
      this.endPath();
    }
  }

  @handle(OPS.paintFormXObjectEnd)
  paintFormXObjectEnd() {
    if (!this.contentVisible) {
      return;
    }
    this.restore();
    this.baseTransform = this.baseTransformStack.pop()!;
  }

  @handle(OPS.beginGroup)
  beginGroup(group: GroupOptions) {
    if (!this.contentVisible) {
      return;
    }

    this.save();
    // If there's an active soft mask we don't want it enabled for the group, so
    // clear it out. The mask and suspended canvas will be restored in endGroup.
    if (this.inSMaskMode) {
      this.endSMaskMode();
      this.current.activeSMask = null;
    }

    const currentCtx = this.ctx;
    // TODO non-isolated groups - according to Rik at adobe non-isolated
    // group results aren't usually that different and they even have tools
    // that ignore this setting. Notes from Rik on implementing:
    // - When you encounter an transparency group, create a new canvas with
    // the dimensions of the bbox
    // - copy the content from the previous canvas to the new canvas
    // - draw as usual
    // - remove the backdrop alpha:
    // alphaNew = 1 - (1 - alpha)/(1 - alphaBackdrop) with 'alpha' the alpha
    // value of your transparency group and 'alphaBackdrop' the alpha of the
    // backdrop
    // - remove background color:
    // colorNew = color - alphaNew *colorBackdrop /(1 - alphaNew)
    if (!group.isolated) {
      info("TODO: Support non-isolated groups.");
    }

    // TODO knockout - supposedly possible with the clever use of compositing
    // modes.
    if (group.knockout) {
      warn("Knockout groups not supported.");
    }

    const currentTransform = getCurrentTransform(currentCtx);
    if (group.matrix) {
      currentCtx.transform(...group.matrix);
    }
    if (!group.bbox) {
      throw new Error("Bounding box is required.");
    }

    // Based on the current transform figure out how big the bounding box
    // will actually be.
    let bounds = Util.getAxialAlignedBoundingBox(
      group.bbox,
      getCurrentTransform(currentCtx)
    );
    // Clip the bounding box to the current canvas.
    const canvasBounds: RectType = [
      0, 0, currentCtx.canvas.width, currentCtx.canvas.height,
    ];

    bounds = Util.intersect(bounds, canvasBounds) || [0, 0, 0, 0];
    // Use ceil in case we're between sizes so we don't create canvas that is
    // too small and make the canvas at least 1x1 pixels.
    const offsetX = Math.floor(bounds[0]);
    const offsetY = Math.floor(bounds[1]);
    const drawnWidth = Math.max(Math.ceil(bounds[2]) - offsetX, 1);
    const drawnHeight = Math.max(Math.ceil(bounds[3]) - offsetY, 1);

    this.current.startNewPathAndClipBox([0, 0, drawnWidth, drawnHeight]);

    let cacheId = "groupAt" + this.groupLevel;
    if (group.smask) {
      // Using two cache entries is case if masks are used one after another.
      cacheId += "_smask_" + (this.smaskCounter++ % 2);
    }
    const scratchCanvas = this.cachedCanvases.getCanvas(
      cacheId, drawnWidth, drawnHeight
    );
    const groupCtx = scratchCanvas.context!;

    // Since we created a new canvas that is just the size of the bounding box
    // we have to translate the group ctx.
    groupCtx.translate(-offsetX, -offsetY);
    groupCtx.transform(...currentTransform);

    if (group.smask) {
      // Saving state and cached mask to be used in setGState.
      this.smaskStack.push({
        canvas: scratchCanvas.canvas,
        context: groupCtx,
        offsetX,
        offsetY,
        subtype: group.smask.subtype,
        backdrop: group.smask.backdrop,
        transferMap: group.smask.transferMap || null,
        startTransformInverse: null, // used during suspend operation
      });
    } else {
      // Setup the current ctx so when the group is popped we draw it at the
      // right location.
      currentCtx.setTransform(1, 0, 0, 1, 0, 0);
      currentCtx.translate(offsetX, offsetY);
      currentCtx.save();
    }
    // The transparency group inherits all off the current graphics state
    // except the blend mode, soft mask, and alpha constants.
    copyCtxState(currentCtx, groupCtx);
    this.ctx = groupCtx;
    this.setGState([
      [DictKey.BM, "source-over"],
      [DictKey.ca, 1],
      [DictKey.CA, 1],
    ]);
    this.groupStack.push(currentCtx);
    this.groupLevel++;
  }

  @handle(OPS.endGroup)
  endGroup(group: GroupOptions) {
    if (!this.contentVisible) {
      return;
    }
    this.groupLevel--;
    const groupCtx = this.ctx;
    const ctx = this.groupStack.pop()!;
    this.ctx = ctx;
    // Turn off image smoothing to avoid sub pixel interpolation which can
    // look kind of blurry for some pdfs.
    this.ctx.imageSmoothingEnabled = false;

    if (group.smask) {
      this.tempSMask = this.smaskStack.pop()!;
      this.restore();
    } else {
      this.ctx.restore();
      const currentMtx = getCurrentTransform(this.ctx);
      this.restore();
      this.ctx.save();
      this.ctx.setTransform(...currentMtx);
      const dirtyBox = Util.getAxialAlignedBoundingBox(
        [0, 0, groupCtx.canvas.width, groupCtx.canvas.height],
        currentMtx
      );
      this.ctx.drawImage(groupCtx.canvas, 0, 0);
      this.ctx.restore();
      this.compose(dirtyBox);
    }
  }

  @handle(OPS.beginAnnotation)
  beginAnnotation(id: string, rect: RectType | null, transform: TransformType, matrix: TransformType, hasOwnCanvas: boolean) {
    // The annotations are drawn just after the page content.
    // The page content drawing can potentially have set a transform,
    // a clipping path, whatever...
    // So in order to have something clean, we restore the initial state.
    this.#restoreInitialState();
    resetCtxToDefault(this.ctx);

    this.ctx.save();
    this.save();

    if (this.baseTransform) {
      this.ctx.setTransform(...this.baseTransform);
    }

    if (rect) {
      const width = rect[2] - rect[0];
      const height = rect[3] - rect[1];

      if (hasOwnCanvas && this.annotationCanvasMap) {
        transform = transform.slice() as TransformType;
        transform[4] -= rect[0];
        transform[5] -= rect[1];

        rect = rect.slice() as RectType;
        rect[0] = rect[1] = 0;
        rect[2] = width;
        rect[3] = height;

        const [scaleX, scaleY] = Util.singularValueDecompose2dScale(
          getCurrentTransform(this.ctx)
        );
        const { viewportScale } = this;
        const canvasWidth = Math.ceil(
          width * this.outputScaleX * viewportScale
        );
        const canvasHeight = Math.ceil(
          height * this.outputScaleY * viewportScale
        );

        this.annotationCanvas = this.canvasFactory.create(
          canvasWidth,
          canvasHeight
        );
        const { canvas, context } = this.annotationCanvas;
        this.annotationCanvasMap.set(id, canvas!);
        this.annotationCanvas.savedCtx = this.ctx;
        this.ctx = context!;
        this.ctx.save();
        this.ctx.setTransform(scaleX, 0, 0, -scaleY, 0, height * scaleY);

        resetCtxToDefault(this.ctx);
      } else {
        resetCtxToDefault(this.ctx);

        // Consume a potential path before clipping.
        this.endPath();

        this.ctx.rect(rect[0], rect[1], width, height);
        this.ctx.clip();
        this.ctx.beginPath();
      }
    }

    this.current = new CanvasExtraState(
      this.ctx.canvas.width,
      this.ctx.canvas.height
    );

    this.transform(...transform);
    this.transform(...matrix);
  }

  @handle(OPS.endAnnotation)
  endAnnotation() {
    if (this.annotationCanvas) {
      this.ctx.restore();
      this.#drawFilter();

      this.ctx = this.annotationCanvas.savedCtx!;
      this.annotationCanvas.savedCtx = undefined;
      this.annotationCanvas = null;
    }
  }

  @handle(OPS.paintImageMaskXObject)
  paintImageMaskXObject(img: {
    data: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
    interpolate: number[];
    count: number;
    bitmap: CanvasImageSource | null;
  }) {
    if (!this.contentVisible) {
      return;
    }
    const count = img.count;
    img = this.getObject(img.data, img);
    img.count = count;

    const ctx = this.ctx;
    const glyph = this.processingType3;

    if (glyph) {
      if (glyph.compiled == null) {
        glyph.compiled = compileType3Glyph(img);
      }

      if (glyph.compiled) {
        glyph.compiled(ctx);
        return;
      }
    }
    const mask = this._createMaskCanvas(img);
    const maskCanvas = mask.canvas;

    ctx.save();
    // The mask is drawn with the transform applied. Reset the current
    // transform to draw to the identity.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(maskCanvas, mask.offsetX, mask.offsetY);
    ctx.restore();
    this.compose();
  }

  @handle(OPS.paintImageMaskXObjectRepeat)
  paintImageMaskXObjectRepeat(
    img: {
      data: Uint8Array<ArrayBuffer>;
      width: number;
      height: number;
      interpolate: number[];
      count: number;
      bitmap: CanvasImageSource | null;
    },
    scaleX: number,
    skewX = 0,
    skewY = 0,
    scaleY: number,
    positions: number[]
  ) {
    if (!this.contentVisible) {
      return;
    }

    img = this.getObject(img.data, img);

    const ctx = this.ctx;
    ctx.save();
    const currentTransform = getCurrentTransform(ctx);
    ctx.transform(scaleX, skewX, skewY, scaleY, 0, 0);
    const mask = this._createMaskCanvas(img);

    ctx.setTransform(
      1, 0, 0, 1, mask.offsetX - currentTransform[4], mask.offsetY - currentTransform[5]
    );
    for (let i = 0, ii = positions.length; i < ii; i += 2) {
      const trans = Util.transform(currentTransform, [
        scaleX,
        skewX,
        skewY,
        scaleY,
        positions[i],
        positions[i + 1],
      ]);

      const [x, y] = Util.applyTransform([0, 0], trans);
      ctx.drawImage(mask.canvas, x, y);
    }
    ctx.restore();
    this.compose();
  }

  @handle(OPS.paintImageMaskXObjectGroup)
  paintImageMaskXObjectGroup(images: {
    data: string;
    width: number;
    height: number;
    interpolate: number[];
    count: number;
    transform: TransformType
  }[]) {
    if (!this.contentVisible) {
      return;
    }
    const ctx = this.ctx;

    const fillColor = this.current.fillColor;
    const isPatternFill = this.current.patternFill;

    for (const image of images) {
      const { data, width, height, transform } = image;

      const maskCanvas = this.cachedCanvases.getCanvas(
        "maskCanvas",
        width,
        height
      );
      const maskCtx = maskCanvas.context!;
      maskCtx.save();

      const img = this.getObject(data, image);
      putBinaryImageMask(maskCtx, img);

      maskCtx.globalCompositeOperation = "source-in";

      maskCtx.fillStyle = isPatternFill ? (<BaseShadingPattern | TilingPattern>fillColor).getPattern(
        maskCtx, this, getCurrentTransformInverse(ctx), PathType.FILL
      ) : <string>fillColor;
      maskCtx.fillRect(0, 0, width, height);

      maskCtx.restore();

      ctx.save();
      ctx.transform(...<TransformType>transform);
      ctx.scale(1, -1);
      drawImageAtIntegerCoords(
        ctx, maskCanvas.canvas!, 0, 0, width, height, 0, -1, 1, 1
      );
      ctx.restore();
    }
    this.compose();
  }

  @handle(OPS.paintImageXObject)
  paintImageXObject(objId: string) {
    if (!this.contentVisible) {
      return;
    }
    const imgData = this.getObject(objId);
    if (!imgData) {
      warn("Dependent image isn't ready yet");
      return;
    }

    this.paintInlineImageXObject(imgData);
  }

  @handle(OPS.paintImageXObjectRepeat)
  paintImageXObjectRepeat(objId: string, scaleX: number, scaleY: number, positions: number[]) {
    if (!this.contentVisible) {
      return;
    }
    const imgData = this.getObject(objId);
    if (!imgData) {
      warn("Dependent image isn't ready yet");
      return;
    }

    const width = imgData.width;
    const height = imgData.height;
    const map: PositionTransformType[] = [];
    for (let i = 0, ii = positions.length; i < ii; i += 2) {
      map.push({
        transform: [scaleX, 0, 0, scaleY, positions[i], positions[i + 1]],
        x: 0,
        y: 0,
        w: width,
        h: height,
      });
    }
    this.paintInlineImageXObjectGroup(imgData, map);
  }

  applyTransferMapsToCanvas(ctx: CanvasRenderingContext2D) {
    if (this.current.transferMaps !== "none") {
      ctx.filter = this.current.transferMaps;
      ctx.drawImage(ctx.canvas, 0, 0);
      ctx.filter = "none";
    }
    return ctx.canvas;
  }

  applyTransferMapsToBitmap(imgData: ImageMask) {
    if (this.current.transferMaps === "none") {
      return imgData.bitmap;
    }
    const { bitmap, width, height } = imgData;
    const tmpCanvas = this.cachedCanvases.getCanvas(
      "inlineImage",
      width,
      height
    );
    const tmpCtx = tmpCanvas.context!;
    tmpCtx.filter = this.current.transferMaps;
    tmpCtx.drawImage(bitmap!, 0, 0);
    tmpCtx.filter = "none";

    return tmpCanvas.canvas;
  }

  @handle(OPS.paintInlineImageXObject)
  paintInlineImageXObject(imgData: ImageMask) {
    if (!this.contentVisible) {
      return;
    }
    const width = imgData.width;
    const height = imgData.height;
    const ctx = this.ctx;

    this.save();


    // The filter, if any, will be applied in applyTransferMapsToBitmap.
    // It must be applied to the image before rescaling else some artifacts
    // could appear.
    // The final restore will reset it to its value.
    const { filter } = ctx;
    if (filter !== "none" && filter !== "") {
      ctx.filter = "none";
    }


    // scale the image to the unit square
    ctx.scale(1 / width, -1 / height);

    let imgToPaint;
    if (imgData.bitmap) {
      imgToPaint = this.applyTransferMapsToBitmap(imgData);
    } else if (
      (typeof HTMLElement === "function" && imgData instanceof HTMLElement) ||
      !imgData.data
    ) {
      // typeof check is needed due to node.js support, see issue #8489
      imgToPaint = imgData;
    } else {
      const tmpCanvas = this.cachedCanvases.getCanvas(
        "inlineImage",
        width,
        height
      );
      const tmpCtx = tmpCanvas.context!;
      putBinaryImageData(tmpCtx, imgData);
      imgToPaint = this.applyTransferMapsToCanvas(tmpCtx);
    }

    const scaled = this._scaleImage(
      <HTMLCanvasElement | VideoFrame>imgToPaint,
      getCurrentTransformInverse(ctx)
    );
    ctx.imageSmoothingEnabled = getImageSmoothingEnabled(
      getCurrentTransform(ctx),
      imgData.interpolate
    );

    drawImageAtIntegerCoords(
      ctx, scaled.img, 0, 0, scaled.paintWidth
      , scaled.paintHeight, 0, -height, width, height
    );
    this.compose();
    this.restore();
  }

  @handle(OPS.paintInlineImageXObjectGroup)
  paintInlineImageXObjectGroup(imgData: {
    width: number,
    height: number,
    kind?: ImageKind,
    data: Uint8TypedArray | null,
    bitmap?: CanvasImageSource,
  }, map: PositionTransformType[]) {
    if (!this.contentVisible) {
      return;
    }
    const ctx = this.ctx;
    let imgToPaint;
    if (imgData.bitmap) {
      imgToPaint = imgData.bitmap;
    } else {
      const w = imgData.width;
      const h = imgData.height;

      const tmpCanvas = this.cachedCanvases.getCanvas("inlineImage", w, h);
      const tmpCtx = tmpCanvas.context!;
      putBinaryImageData(tmpCtx, imgData);
      imgToPaint = this.applyTransferMapsToCanvas(tmpCtx);
    }

    for (const entry of map) {
      ctx.save();
      ctx.transform(...entry.transform);
      ctx.scale(1, -1);
      drawImageAtIntegerCoords(
        ctx, imgToPaint, entry.x, entry.y, entry.w, entry.h, 0, -1, 1, 1
      );
      ctx.restore();
    }
    this.compose();
  }

  @handle(OPS.paintSolidColorImageMask)
  paintSolidColorImageMask() {
    if (!this.contentVisible) {
      return;
    }
    this.ctx.fillRect(0, 0, 1, 1);
    this.compose();
  }

  // Marked content
  @handle(OPS.markPoint)
  markPoint(_tag: unknown) {
    // TODO Marked content.
  }

  @handle(OPS.markPointProps)
  markPointProps(_tag: unknown, _properties: unknown) {
    // TODO Marked content.
  }

  @handle(OPS.beginMarkedContent)
  beginMarkedContent(_tag: unknown) {
    this.markedContentStack.push({
      visible: true,
    });
  }

  @handle(OPS.beginMarkedContentProps)
  beginMarkedContentProps(tag: string, properties: OptionalContent) {
    if (tag === "OC") {
      this.markedContentStack.push({
        visible: this.optionalContentConfig.isVisible(properties),
      });
    } else {
      this.markedContentStack.push({
        visible: true,
      });
    }
    this.contentVisible = this.isContentVisible();
  }

  @handle(OPS.endMarkedContent)
  endMarkedContent() {
    this.markedContentStack.pop();
    this.contentVisible = this.isContentVisible();
  }

  // Compatibility
  @handle(OPS.beginCompat)
  beginCompat() {
    // TODO ignore undefined operators (should we do that anyway?)
  }

  @handle(OPS.endCompat)
  endCompat() {
    // TODO stop ignoring undefined operators
  }

  // Helper functions
  consumePath(clipBox: RectType | null = null) {
    const isEmpty = this.current.isEmptyClip();
    if (this.pendingClip) {
      this.current.updateClipFromPath();
    }
    if (!this.pendingClip) {
      this.compose(clipBox);
    }
    const ctx = this.ctx;
    if (this.pendingClip) {
      if (!isEmpty) {
        if (this.pendingClip === EO_CLIP) {
          ctx.clip("evenodd");
        } else {
          ctx.clip();
        }
      }
      this.pendingClip = null;
    }
    this.current.startNewPathAndClipBox(this.current.clipBox!);
    ctx.beginPath();
  }

  getSinglePixelWidth() {
    if (!this._cachedGetSinglePixelWidth) {
      const m = getCurrentTransform(this.ctx);
      if (m[1] === 0 && m[2] === 0) {
        // Fast path
        this._cachedGetSinglePixelWidth =
          1 / Math.min(Math.abs(m[0]), Math.abs(m[3]));
      } else {
        const absDet = Math.abs(m[0] * m[3] - m[2] * m[1]);
        const normX = Math.hypot(m[0], m[2]);
        const normY = Math.hypot(m[1], m[3]);
        this._cachedGetSinglePixelWidth = Math.max(normX, normY) / absDet;
      }
    }
    return this._cachedGetSinglePixelWidth;
  }

  getScaleForStroking() {
    // A pixel has thicknessX = thicknessY = 1;
    // A transformed pixel is a parallelogram and the thicknesses
    // corresponds to the heights.
    // The goal of this function is to rescale before setting the
    // lineWidth in order to have both thicknesses greater or equal
    // to 1 after transform.
    if (this._cachedScaleForStroking[0] === -1) {
      const { lineWidth } = this.current;
      const { a, b, c, d } = this.ctx.getTransform();
      let scaleX, scaleY;

      if (b === 0 && c === 0) {
        // Fast path
        const normX = Math.abs(a);
        const normY = Math.abs(d);
        if (normX === normY) {
          if (lineWidth === 0) {
            scaleX = scaleY = 1 / normX;
          } else {
            const scaledLineWidth = normX * lineWidth;
            scaleX = scaleY = scaledLineWidth < 1 ? 1 / scaledLineWidth : 1;
          }
        } else if (lineWidth === 0) {
          scaleX = 1 / normX;
          scaleY = 1 / normY;
        } else {
          const scaledXLineWidth = normX * lineWidth;
          const scaledYLineWidth = normY * lineWidth;
          scaleX = scaledXLineWidth < 1 ? 1 / scaledXLineWidth : 1;
          scaleY = scaledYLineWidth < 1 ? 1 / scaledYLineWidth : 1;
        }
      } else {
        // A pixel (base (x, y)) is transformed by M into a parallelogram:
        //  - its area is |det(M)|;
        //  - heightY (orthogonal to Mx) has a length: |det(M)| / norm(Mx);
        //  - heightX (orthogonal to My) has a length: |det(M)| / norm(My).
        // heightX and heightY are the thicknesses of the transformed pixel
        // and they must be both greater or equal to 1.
        const absDet = Math.abs(a * d - b * c);
        const normX = Math.hypot(a, b);
        const normY = Math.hypot(c, d);
        if (lineWidth === 0) {
          scaleX = normY / absDet;
          scaleY = normX / absDet;
        } else {
          const baseArea = lineWidth * absDet;
          scaleX = normY > baseArea ? normY / baseArea : 1;
          scaleY = normX > baseArea ? normX / baseArea : 1;
        }
      }
      this._cachedScaleForStroking[0] = scaleX;
      this._cachedScaleForStroking[1] = scaleY;
    }
    return this._cachedScaleForStroking;
  }

  // Rescale before stroking in order to have a final lineWidth
  // with both thicknesses greater or equal to 1.
  rescaleAndStroke(saveRestore: boolean) {
    const { ctx } = this;
    const { lineWidth } = this.current;
    const [scaleX, scaleY] = this.getScaleForStroking();

    ctx.lineWidth = lineWidth || 1;

    if (scaleX === 1 && scaleY === 1) {
      ctx.stroke();
      return;
    }

    const dashes = ctx.getLineDash();
    if (saveRestore) {
      ctx.save();
    }

    ctx.scale(scaleX, scaleY);

    // How the dashed line is rendered depends on the current transform...
    // so we added a rescale to handle too thin lines and consequently
    // the way the line is dashed will be modified.
    // If scaleX === scaleY, the dashed lines will be rendered correctly
    // else we'll have some bugs (but only with too thin lines).
    // Here we take the max... why not taking the min... or something else.
    // Anyway, as said it's buggy when scaleX !== scaleY.
    if (dashes.length > 0) {
      const scale = Math.max(scaleX, scaleY);
      ctx.setLineDash(dashes.map(x => x / scale));
      ctx.lineDashOffset /= scale;
    }

    ctx.stroke();

    if (saveRestore) {
      ctx.restore();
    }
  }

  isContentVisible() {
    for (let i = this.markedContentStack.length - 1; i >= 0; i--) {
      if (!this.markedContentStack[i].visible) {
        return false;
      }
    }
    return true;
  }
}
