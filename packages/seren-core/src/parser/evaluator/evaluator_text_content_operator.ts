import {
  AbortException,
  assert,
  assertNotNull,
  Dict,
  DictKey,
  DocumentEvaluatorOptions,
  EvaluatorTextContent,
  FONT_IDENTITY_MATRIX,
  FormatError,
  IDENTITY_MATRIX,
  isArrayEqual,
  MutableArray,
  Name,
  normalizeUnicode,
  OPS,
  Ref,
  StreamSink,
  TransformType,
  Util,
  warn,
  WorkerTask
} from "seren-common";
import { DefaultTextContentItem, TextContentSinkProxy } from "../../common/core_types";
import { DictImpl } from "../../document/dict_impl";
import { Font } from "../../document/font/fonts";
import { XRefImpl } from "../../document/xref";
import { GlobalImageCache, LocalConditionCache, LocalGStateCache } from "../../image/image_utils";
import { BaseStream } from "../../stream/base_stream";
import { bidi } from "../../tables/bidi";
import { lookupMatrix } from "../../utils/core_utils";
import { EvaluatorContext, EvaluatorPreprocessor, StateManager, TextState, TimeSlotManager } from "./evaluator";
import { OperatorListHandler, OVER, ProcessOperation, SKIP } from "./evaluator_base";
import { EvaluatorColorHandler } from "./evaluator_color_handler";
import { EvaluatorFontHandler } from "./evaluator_font_handler";
import { EvaluatorGeneralHandler } from "./evaluator_general_handler";
import { EvaluatorImageHandler } from "./evaluator_image_handler";

const MethodMap = new Map<OPS, keyof TextContentOperator>();

// 这里应该要有handle完的arg类型，但是这种arg类型不太好强制管理起来
// 强制起来得打开一个开关，开关检测args处理的对不对
function handle(ops: OPS) {
  return function (target: TextContentOperator, propertyKey: keyof TextContentOperator) {
    if (MethodMap.has(ops)) {
      throw new Error("不能够重复为同一个操作符定义多个操作对象")
    }
    if (typeof target[propertyKey] === "function") {
      MethodMap.set(ops, propertyKey);
    }
  }
}

interface ProcessContext extends ProcessOperation {
  previousState: TextState | null;
  idFactory: any;
  options: DocumentEvaluatorOptions;
  markedContentData: { level: 0; } | null;
  lang: string | null;
  xref: XRefImpl;
  xobjs: Dict | null;
  sink: StreamSink<EvaluatorTextContent>;
  viewBox: number[];
  task: WorkerTask;
  textContent: EvaluatorTextContent;
  textContentItem: DefaultTextContentItem;
  globalImageCache: GlobalImageCache;
  emptyXObjectCache: LocalConditionCache;
  emptyGStateCache: LocalGStateCache;
  includeMarkedContent: boolean;
  pageIndex: number;
  resources: Dict;
  showSpacedTextBuffer: string[];
  textState: TextState | null;
  stateManager: StateManager;
  preprocessor: EvaluatorPreprocessor;
  timeSlotManager: TimeSlotManager;
  keepWhiteSpace: boolean;
  disableNormalization: boolean;
  seenStyles: Set<string>;
  next: (promise: Promise<unknown>) => void;
}

class OperatorAssist {

  // Optionally avoid sending individual, or very few, text chunks to reduce
  // `postMessage` overhead with ReadableStream (see issue 13962).
  //
  // PLEASE NOTE: This value should *not* be too large (it's used as a lower limit
  // in `enqueueChunk`), since that would cause streaming of textContent to become
  // essentially useless in practice by sending all (or most) chunks at once.
  // Also, a too large value would (indirectly) affect the main-thread `textLayer`
  // building negatively by forcing all textContent to be handled at once, which
  // could easily end up hurting *overall* performance (e.g. rendering as well).
  readonly TEXT_CHUNK_BATCH_SIZE = 10;

  // A white <= fontSize * TRACKING_SPACE_FACTOR is a tracking space
  // so it doesn't count as a space.
  readonly TRACKING_SPACE_FACTOR = 0.102;

  // When a white <= fontSize * NOT_A_SPACE_FACTOR, there is no space
  // even if one is present in the text stream.
  readonly NOT_A_SPACE_FACTOR = 0.03;

  // A negative white < fontSize * NEGATIVE_SPACE_FACTOR induces
  // a break (a new chunk of text is created).
  // It doesn't change anything when the text is copied but
  // it improves potential mismatch between text layer and canvas.
  readonly NEGATIVE_SPACE_FACTOR = -0.2;

  // A white with a width in [fontSize * MIN_FACTOR; fontSize * MAX_FACTOR]
  // is a space which will be inserted in the current flow of words.
  // If the width is outside of this range then the flow is broken
  // (which means a new span in the text layer).
  // It's useful to adjust the best as possible the span in the layer
  // to what is displayed in the canvas.
  readonly SPACE_IN_FLOW_MIN_FACTOR = 0.102;
  readonly SPACE_IN_FLOW_MAX_FACTOR = 0.6;

  // If a char is too high/too low compared to the previous we just create
  // a new chunk.
  // If the advance isn't in the +/-VERTICAL_SHIFT_RATIO * height range then
  // a new chunk is created.
  readonly VERTICAL_SHIFT_RATIO = 0.25;

  readonly twoLastChars = [" ", " "];

  protected twoLastCharsPos = 0;

  protected ctx: ProcessContext;

  protected evalCtx: EvaluatorContext;

  constructor(ctx: ProcessContext, evalCtx: EvaluatorContext) {
    this.ctx = ctx;
    this.evalCtx = evalCtx;
  }

  saveLastChar(char: string): boolean {
    const nextPos = (this.twoLastCharsPos + 1) % 2;
    const ret = this.twoLastChars[this.twoLastCharsPos] !== " " && this.twoLastChars[nextPos] === " ";
    this.twoLastChars[this.twoLastCharsPos] = char;
    this.twoLastCharsPos = nextPos;
    return !this.ctx.keepWhiteSpace && ret;
  }

  shouldAddWhitepsace() {
    return (
      !this.ctx.keepWhiteSpace &&
      this.twoLastChars[this.twoLastCharsPos] !== " " &&
      this.twoLastChars[(this.twoLastCharsPos + 1) % 2] === " "
    );
  }

  resetLastChars() {
    this.twoLastChars[0] = this.twoLastChars[1] = " ";
    this.twoLastCharsPos = 0;
  }

  pushWhitespace(
    width = 0, height = 0,
    transform = this.ctx.textContentItem.prevTransform,
    fontName = this.ctx.textContentItem.fontName,
  ): void {
    this.ctx.textContent.items.push({
      str: " ",
      dir: "ltr",
      width,
      height,
      transform,
      fontName: fontName!,
      hasEOL: false,
    });
  }

  getCurrentTextTransform() {
    const textState = this.ctx.textState!;
    // 9.4.4 Text Space Details
    const font = textState.font!;
    const fontSize = textState.fontSize;
    const textHScale = textState.textHScale;
    const textRise = textState.textRise;
    const tsm = [fontSize * textHScale, 0, 0, fontSize, 0, textRise];

    if (
      font.isType3Font &&
      (textState.fontSize <= 1 || font.isCharBBox) &&
      !isArrayEqual(textState.fontMatrix, FONT_IDENTITY_MATRIX)
    ) {
      const glyphHeight = (<Font>font).bbox![3] - (<Font>font).bbox![1];
      if (glyphHeight > 0) {
        tsm[3] *= glyphHeight * textState.fontMatrix[3];
      }
    }

    return Util.transform(
      textState.ctm, Util.transform(textState.textMatrix, tsm)
    );
  }

  ensureTextContentItem() {
    if (this.ctx.textContentItem.initialized) {
      return this.ctx.textContentItem;
    }
    const ctx = this.ctx;
    const textState = ctx.textState!;
    const seenStyles = ctx.seenStyles;
    const font = textState.font!;
    const loadedName = textState!.loadedName!;
    if (!seenStyles.has(loadedName)) {
      const validFont = <Font>font;
      seenStyles.add(loadedName);
      const style = {
        fontFamily: (validFont).fallbackName,
        ascent: (validFont).ascent,
        descent: (validFont).descent,
        vertical: (validFont).vertical!,
        fontSubstitution: null,
        fontSubstitutionLoadedName: null,
      }
      this.ctx.textContent.styles.set(loadedName, style);
      if (this.evalCtx.options.fontExtraProperties && (validFont).systemFontInfo) {
        const style = this.ctx.textContent.styles.get(loadedName)!;
        style.fontSubstitution = (validFont).systemFontInfo!.css;
        style.fontSubstitutionLoadedName = (validFont).systemFontInfo!.loadedName;
      }
    }
    this.ctx.textContentItem.fontName = loadedName;

    const trm = (this.ctx.textContentItem.transform = this.getCurrentTextTransform());
    if (!font.vertical) {
      ctx.textContentItem.width = ctx.textContentItem.totalWidth = 0;
      ctx.textContentItem.height = ctx.textContentItem.totalHeight = Math.hypot(trm[2], trm[3]);
      ctx.textContentItem.vertical = false;
    } else {
      ctx.textContentItem.width = ctx.textContentItem.totalWidth = Math.hypot(trm[0], trm[1]);
      ctx.textContentItem.height = ctx.textContentItem.totalHeight = 0;
      ctx.textContentItem.vertical = true;
    }

    const scaleLineX = Math.hypot(
      textState!.textLineMatrix[0], textState!.textLineMatrix[1]
    );

    const scaleCtmX = Math.hypot(textState!.ctm[0], textState!.ctm[1]);
    ctx.textContentItem.textAdvanceScale = scaleCtmX * scaleLineX;

    const { fontSize } = textState!;
    ctx.textContentItem.trackingSpaceMin = fontSize * this.TRACKING_SPACE_FACTOR;
    ctx.textContentItem.notASpace = fontSize * this.NOT_A_SPACE_FACTOR;
    ctx.textContentItem.negativeSpaceMax = fontSize * this.NEGATIVE_SPACE_FACTOR;
    ctx.textContentItem.spaceInFlowMin = fontSize * this.SPACE_IN_FLOW_MIN_FACTOR;
    ctx.textContentItem.spaceInFlowMax = fontSize * this.SPACE_IN_FLOW_MAX_FACTOR;
    ctx.textContentItem.hasEOL = false;

    ctx.textContentItem.initialized = true;
    return ctx.textContentItem;
  }

  updateAdvanceScale(textState: TextState) {
    const textContentItem = this.ctx.textContentItem;
    if (!textContentItem.initialized) {
      return;
    }

    const scaleLineX = Math.hypot(
      textState!.textLineMatrix[0],
      textState!.textLineMatrix[1]
    );
    const scaleCtmX = Math.hypot(textState!.ctm[0], textState!.ctm[1]);
    const scaleFactor = scaleCtmX * scaleLineX;
    if (scaleFactor === textContentItem.textAdvanceScale) {
      return;
    }

    if (!textContentItem.vertical) {
      textContentItem.totalWidth += textContentItem.width * textContentItem.textAdvanceScale;
      textContentItem.width = 0;
    } else {
      textContentItem.totalHeight += textContentItem.height * textContentItem.textAdvanceScale;
      textContentItem.height = 0;
    }

    textContentItem.textAdvanceScale = scaleFactor;
  }

  runBidiTransform(textChunk: DefaultTextContentItem) {
    let text = textChunk.str.join("");
    if (!this.ctx.disableNormalization) {
      text = normalizeUnicode(text);
    }
    const bidiResult = bidi(text, -1, textChunk.vertical);
    return {
      str: bidiResult.str,
      dir: bidiResult.dir,
      width: Math.abs(textChunk.totalWidth),
      height: Math.abs(textChunk.totalHeight),
      transform: textChunk.transform,
      fontName: textChunk.fontName!,
      hasEOL: textChunk.hasEOL,
    };
  }

  async handleSetFont(fontName: string | null, fontRef: Ref | null) {
    const translated = await this.evalCtx.fontHandler.loadFont(
      fontName, fontRef, this.ctx.resources
    );

    if (translated.font.isType3Font) {
      try {
        await translated.loadType3Data(this.evalCtx, this.ctx.resources!, this.ctx.task);
      } catch {
        // Ignore Type3-parsing errors, since we only use `loadType3Data`
        // here to ensure that we'll always obtain a useful /FontBBox.
      }
    }

    assertNotNull(this.ctx.textState);

    this.ctx.textState.loadedName = translated.loadedName;
    this.ctx.textState.font = translated.font!;
    this.ctx.textState.fontMatrix = translated.font.fontMatrix || FONT_IDENTITY_MATRIX;
  }

  applyInverseRotation(x: number, y: number, matrix: TransformType) {
    const scale = Math.hypot(matrix[0], matrix[1]);
    return [
      (matrix[0] * x + matrix[1] * y) / scale,
      (matrix[2] * x + matrix[3] * y) / scale,
    ];
  }

  compareWithLastPosition(glyphWidth: number) {
    const currentTransform = this.getCurrentTextTransform();
    const textContentItem = this.ctx.textContentItem;
    let posX = currentTransform[4];
    let posY = currentTransform[5];

    // Check if the glyph is in the viewbox.
    const viewBox = this.ctx.viewBox;
    if (this.ctx.textState!.font?.vertical) {
      if (
        posX < viewBox[0] ||
        posX > viewBox[2] ||
        posY + glyphWidth < viewBox[1] ||
        posY > viewBox[3]
      ) {
        return false;
      }
    } else if (
      posX + glyphWidth < viewBox[0] ||
      posX > viewBox[2] ||
      posY < viewBox[1] ||
      posY > viewBox[3]
    ) {
      return false;
    }

    if (!this.ctx.textState!.font || !textContentItem.prevTransform) {
      return true;
    }

    let lastPosX = textContentItem.prevTransform[4];
    let lastPosY = textContentItem.prevTransform[5];

    if (lastPosX === posX && lastPosY === posY) {
      return true;
    }

    let rotate = -1;
    // Take into account the rotation is the current transform.
    if (
      currentTransform[0] &&
      currentTransform[1] === 0 &&
      currentTransform[2] === 0
    ) {
      rotate = currentTransform[0] > 0 ? 0 : 180;
    } else if (
      currentTransform[1] &&
      currentTransform[0] === 0 &&
      currentTransform[3] === 0
    ) {
      rotate = currentTransform[1] > 0 ? 90 : 270;
    }

    switch (rotate) {
      case 0:
        break;
      case 90:
        [posX, posY] = [posY, posX];
        [lastPosX, lastPosY] = [lastPosY, lastPosX];
        break;
      case 180:
        [posX, posY, lastPosX, lastPosY] = [-posX, -posY, -lastPosX, -lastPosY];
        break;
      case 270:
        [posX, posY] = [-posY, -posX];
        [lastPosX, lastPosY] = [-lastPosY, -lastPosX];
        break;
      default:
        // This is not a 0, 90, 180, 270 rotation so:
        //  - remove the scale factor from the matrix to get a rotation matrix
        //  - apply the inverse (which is the transposed) to the positions
        // and we can then compare positions of the glyphes to detect
        // a whitespace.
        [posX, posY] = this.applyInverseRotation(posX, posY, currentTransform);
        [lastPosX, lastPosY] = this.applyInverseRotation(
          lastPosX, lastPosY, textContentItem.prevTransform
        );
    }

    if (this.ctx.textState!.font.vertical) {
      const advanceY = (lastPosY - posY) / textContentItem.textAdvanceScale;
      const advanceX = posX - lastPosX;

      // When the total height of the current chunk is negative
      // then we're writing from bottom to top.
      const textOrientation = Math.sign(textContentItem.height);
      if (advanceY < textOrientation * textContentItem.negativeSpaceMax) {
        /* not the same column */
        if (Math.abs(advanceX) > 0.5 * textContentItem.width) {
          this.appendEOL();
          return true;
        }

        this.resetLastChars();
        this.flushTextContentItem();
        return true;
      }

      if (Math.abs(advanceX) > textContentItem.width) {
        this.appendEOL();
        return true;
      }

      if (advanceY <= textOrientation * textContentItem.notASpace) {
        // The real spacing between 2 consecutive chars is thin enough to be
        // considered a non-space.
        this.resetLastChars();
      }

      if (advanceY <= textOrientation * textContentItem.trackingSpaceMin) {
        if (this.shouldAddWhitepsace()) {
          // The space is very thin, hence it deserves to have its own span in
          // order to avoid too much shift between the canvas and the text
          // layer.
          this.resetLastChars();
          this.flushTextContentItem();
          this.pushWhitespace(0, Math.abs(advanceY));
        } else {
          textContentItem.height += advanceY;
        }
      } else if (!this.addFakeSpaces(advanceY, textContentItem.prevTransform, textOrientation)) {
        if (textContentItem.str.length === 0) {
          this.resetLastChars();
          this.pushWhitespace(0, Math.abs(advanceY));
        } else {
          textContentItem.height += advanceY;
        }
      }

      if (Math.abs(advanceX) > textContentItem.width * this.VERTICAL_SHIFT_RATIO) {
        this.flushTextContentItem();
      }

      return true;
    }

    const advanceX = (posX - lastPosX) / textContentItem.textAdvanceScale;
    const advanceY = posY - lastPosY;

    // When the total width of the current chunk is negative
    // then we're writing from right to left.
    const textOrientation = Math.sign(textContentItem.width);
    if (advanceX < textOrientation * textContentItem.negativeSpaceMax) {
      /* not the same line */
      if (Math.abs(advanceY) > 0.5 * textContentItem.height) {
        this.appendEOL();
        return true;
      }

      // We're moving back so in case the last char was a whitespace
      // we cancel it: it doesn't make sense to insert it.
      this.resetLastChars();
      this.flushTextContentItem();
      return true;
    }

    if (Math.abs(advanceY) > textContentItem.height) {
      this.appendEOL();
      return true;
    }

    if (advanceX <= textOrientation * textContentItem.notASpace) {
      // The real spacing between 2 consecutive chars is thin enough to be
      // considered a non-space.
      this.resetLastChars();
    }

    if (advanceX <= textOrientation * textContentItem.trackingSpaceMin) {
      if (this.shouldAddWhitepsace()) {
        // The space is very thin, hence it deserves to have its own span in
        // order to avoid too much shift between the canvas and the text
        // layer.
        this.resetLastChars();
        this.flushTextContentItem();
        this.pushWhitespace(Math.abs(advanceX));
      } else {
        textContentItem.width += advanceX;
      }
    } else if (!this.addFakeSpaces(advanceX, textContentItem.prevTransform, textOrientation)) {
      if (textContentItem.str.length === 0) {
        this.resetLastChars();
        this.pushWhitespace(Math.abs(advanceX));
      } else {
        textContentItem.width += advanceX;
      }
    }

    if (Math.abs(advanceY) > textContentItem.height * this.VERTICAL_SHIFT_RATIO) {
      this.flushTextContentItem();
    }
    return true;
  }

  buildTextContentItem(chars: string, extraSpacing: number) {
    const textState = this.ctx.textState!;
    const font = textState.font!;
    if (!chars) {
      // Just move according to the space we have.
      const charSpacing = textState.charSpacing + extraSpacing;
      if (charSpacing) {
        if (!font!.vertical) {
          textState.translateTextMatrix(charSpacing * textState.textHScale, 0);
        } else {
          textState.translateTextMatrix(0, -charSpacing);
        }
      }
      if (this.ctx.keepWhiteSpace) {
        this.compareWithLastPosition(0);
      }
      return;
    }

    const glyphs = font!.charsToGlyphs(chars);
    const scale = textState.fontMatrix[0] * textState.fontSize;

    for (let i = 0, ii = glyphs.length; i < ii; i++) {
      const glyph = glyphs[i];
      const { category } = glyph;

      if (category.isInvisibleFormatMark) {
        continue;
      }
      let charSpacing = textState!.charSpacing + (i + 1 === ii ? extraSpacing : 0);

      let glyphWidth = glyph.width;
      if (font!.vertical) {
        glyphWidth = glyph.vmetric ? glyph.vmetric[0] : -glyphWidth;
      }
      let scaledDim = glyphWidth * scale;

      if (!this.ctx.keepWhiteSpace && category.isWhitespace) {
        // Don't push a " " in the textContentItem
        // (except when it's between two non-spaces chars),
        // it will be done (if required) in next call to
        // compareWithLastPosition.
        // This way we can merge real spaces and spaces due to cursor moves.
        if (!font!.vertical) {
          charSpacing += scaledDim + textState!.wordSpacing;
          textState!.translateTextMatrix(charSpacing * textState!.textHScale, 0);
        } else {
          charSpacing += -scaledDim + textState!.wordSpacing;
          textState!.translateTextMatrix(0, -charSpacing);
        }
        this.saveLastChar(" ");
        continue;
      }

      if (!category.isZeroWidthDiacritic && !this.compareWithLastPosition(scaledDim)) {
        // The glyph is not in page so just skip it but move the cursor.
        if (!font!.vertical) {
          textState!.translateTextMatrix(scaledDim * textState!.textHScale, 0);
        } else {
          textState!.translateTextMatrix(0, scaledDim);
        }
        continue;
      }

      // Must be called after compareWithLastPosition because
      // the textContentItem could have been flushed.
      const textChunk = this.ensureTextContentItem();
      if (category.isZeroWidthDiacritic) {
        scaledDim = 0;
      }

      if (!font!.vertical) {
        scaledDim *= textState!.textHScale;
        textState!.translateTextMatrix(scaledDim, 0);
        textChunk.width += scaledDim;
      } else {
        textState!.translateTextMatrix(0, scaledDim);
        scaledDim = Math.abs(scaledDim);
        textChunk.height += scaledDim;
      }

      if (scaledDim) {
        // Save the position of the last visible character.
        textChunk.prevTransform = this.getCurrentTextTransform();
      }

      const glyphUnicode = glyph.unicode;
      if (this.saveLastChar(glyphUnicode)) {
        // The two last chars are a non-whitespace followed by a whitespace
        // and then this non-whitespace, so we insert a whitespace here.
        // Replaces all whitespaces with standard spaces (0x20), to avoid
        // alignment issues between the textLayer and the canvas if the text
        // contains e.g. tabs (fixes issue6612.pdf).
        textChunk.str.push(" ");
      }
      textChunk.str.push(glyphUnicode);

      if (charSpacing) {
        if (!font!.vertical) {
          textState!.translateTextMatrix(charSpacing * textState!.textHScale, 0);
        } else {
          textState!.translateTextMatrix(0, -charSpacing);
        }
      }
    }
  }

  appendEOL() {
    this.resetLastChars();
    if (this.ctx.textContentItem.initialized) {
      this.ctx.textContentItem.hasEOL = true;
      this.flushTextContentItem();
    } else {
      this.ctx.textContent.items.push({
        str: "",
        dir: "ltr",
        width: 0,
        height: 0,
        transform: this.getCurrentTextTransform(),
        fontName: this.ctx.textState!.loadedName!,
        hasEOL: true,
      });
    }
  }

  addFakeSpaces(width: number, transf: TransformType | null, textOrientation: number) {
    const textContentItem = this.ctx.textContentItem;
    if (
      textOrientation * textContentItem.spaceInFlowMin <= width &&
      width <= textOrientation * textContentItem.spaceInFlowMax
    ) {
      if (textContentItem.initialized) {
        this.resetLastChars();
        textContentItem.str.push(" ");
      }
      return false;
    }

    const fontName = textContentItem.fontName;

    let height = 0;
    if (textContentItem.vertical) {
      height = width;
      width = 0;
    }

    this.flushTextContentItem();
    this.resetLastChars();
    this.pushWhitespace(
      Math.abs(width), Math.abs(height), transf || this.getCurrentTextTransform(), fontName
    );

    return true;
  }

  flushTextContentItem() {
    const { textContentItem, textContent } = this.ctx;
    if (!textContentItem.initialized || !textContentItem.str) {
      return;
    }

    // Do final text scaling.
    if (!textContentItem.vertical) {
      textContentItem.totalWidth +=
        textContentItem.width * textContentItem.textAdvanceScale;
    } else {
      textContentItem.totalHeight +=
        textContentItem.height * textContentItem.textAdvanceScale;
    }

    textContent.items.push(this.runBidiTransform(textContentItem));
    textContentItem.initialized = false;
    textContentItem.str.length = 0;
  }

  enqueueChunk(batch = false) {
    const textContent = this.ctx.textContent;
    const length = textContent.items.length;
    if (length === 0) {
      return;
    }
    if (batch && length < this.TEXT_CHUNK_BATCH_SIZE) {
      return;
    }
    this.ctx.sink.enqueue(textContent, length);
    textContent.items = [];
    textContent.styles = new Map();
  }
}

export class TextContentOperator {

  protected context: EvaluatorContext;

  protected generalHandler: EvaluatorGeneralHandler;

  protected fontHandler: EvaluatorFontHandler;

  protected imageHandler: EvaluatorImageHandler;

  protected colorHandler: EvaluatorColorHandler;

  protected operator = new Map<OPS, (context: ProcessContext, assist: OperatorAssist) => void | /*SKIP*/1 | /*OVER*/2>();

  constructor(context: EvaluatorContext) {
    this.generalHandler = context.generalHandler;
    this.fontHandler = context.fontHandler;
    this.imageHandler = context.imageHandler;
    this.colorHandler = context.colorHandler;
    this.context = context;
    for (const [k, v] of MethodMap) {
      const fn = this[v];
      if (fn == null || typeof fn !== 'function') {
        throw new Error("操作符和操作方法不匹配");
      }
      this.operator.set(k, <(context: ProcessContext, assist: OperatorAssist) => void | 1 | 2>fn);
    }
  }

  execute(ops: OPS, context: ProcessContext, assist: OperatorAssist): void | 1 | 2 {
    const fn = this.operator.get(ops);
    return fn ? fn(context, assist) : undefined;
  }

  @handle(OPS.setFont)
  setFont(ctx: ProcessContext, assist: OperatorAssist) {
    const fontNameArg = ctx.args![0].name;
    const fontSizeArg = ctx.args![1];
    if (
      ctx.textState!.font &&
      fontNameArg === ctx.textState!.fontName &&
      fontSizeArg === ctx.textState!.fontSize
    ) {
      return
    }

    assist.flushTextContentItem();
    ctx.textState!.fontName = fontNameArg;
    ctx.textState!.fontSize = fontSizeArg;
    ctx.next(assist.handleSetFont(fontNameArg, null));
    return OVER
  }

  @handle(OPS.setTextRise)
  setTextRise(ctx: ProcessContext) {
    ctx.textState!.textRise = ctx.args![0];
  }

  @handle(OPS.setHScale)
  setHScale(ctx: ProcessContext) {
    ctx.textState!.textHScale = ctx.args![0] / 100;
  }

  @handle(OPS.setLeading)
  setLeading(ctx: ProcessContext) {
    ctx.textState!.leading = ctx.args![0];
  }

  @handle(OPS.moveText)
  moveText(ctx: ProcessContext) {
    ctx.textState!.translateTextLineMatrix(ctx.args![0], ctx.args![1]);
    ctx.textState!.textMatrix = ctx.textState!.textLineMatrix.slice();
  }

  @handle(OPS.setLeadingMoveText)
  setLeadingMoveText(ctx: ProcessContext) {
    ctx.textState!.leading = -ctx.args![1];
    ctx.textState!.translateTextLineMatrix(ctx.args![0], ctx.args![1]);
    ctx.textState!.textMatrix = ctx.textState!.textLineMatrix.slice();
  }

  @handle(OPS.nextLine)
  nextLine(ctx: ProcessContext) {
    ctx.textState!.carriageReturn();
  }

  @handle(OPS.setTextMatrix)
  setTextMatrix(ctx: ProcessContext, assist: OperatorAssist) {
    const args = ctx.args!;
    ctx.textState!.setTextMatrix(args[0], args[1], args[2], args[3], args[4], args[5]);
    ctx.textState!.setTextLineMatrix(args[0], args[1], args[2], args[3], args[4], args[5]);
    assist.updateAdvanceScale(ctx.textState!);
  }

  @handle(OPS.setCharSpacing)
  setCharSpacing(ctx: ProcessContext) {
    ctx.textState!.charSpacing = ctx.args![0];
  }

  @handle(OPS.setWordSpacing)
  setWordSpacing(ctx: ProcessContext) {
    ctx.textState!.wordSpacing = ctx.args![0];
  }

  @handle(OPS.beginText)
  beginText(ctx: ProcessContext) {
    ctx.textState!.textMatrix = IDENTITY_MATRIX.slice();
    ctx.textState!.textLineMatrix = IDENTITY_MATRIX.slice();
  }

  @handle(OPS.showSpacedText)
  showSpaceText(ctx: ProcessContext, assist: OperatorAssist) {
    if (!ctx.stateManager.state.font) {
      this.fontHandler.ensureStateFont(ctx.stateManager.state);
      return SKIP
    }

    const textState = ctx.textState!;
    const spaceFactor = ((textState.font!.vertical ? 1 : -1) * textState.fontSize) / 1000;
    const elements = ctx.args![0];
    for (let i = 0, ii = elements.length; i < ii; i++) {
      const item = elements[i];
      if (typeof item === "string") {
        ctx.showSpacedTextBuffer.push(item);
      } else if (typeof item === "number" && item !== 0) {
        // PDF Specification 5.3.2 states:
        // The number is expressed in thousandths of a unit of text
        // space.
        // This amount is subtracted from the current horizontal or
        // vertical coordinate, depending on the writing mode.
        // In the default coordinate system, a positive adjustment
        // has the effect of moving the next glyph painted either to
        // the left or down by the given amount.
        const str = ctx.showSpacedTextBuffer.join("");
        ctx.showSpacedTextBuffer.length = 0;
        assist.buildTextContentItem(str, item * spaceFactor);
      }
    }

    if (ctx.showSpacedTextBuffer.length > 0) {
      const str = ctx.showSpacedTextBuffer.join("");
      ctx.showSpacedTextBuffer.length = 0;
      assist.buildTextContentItem(str, 0);
    }
  }

  @handle(OPS.showText)
  showText(ctx: ProcessContext, assist: OperatorAssist) {
    if (!ctx.stateManager.state.font) {
      this.fontHandler.ensureStateFont(ctx.stateManager.state);
      return SKIP
    }
    assist.buildTextContentItem(ctx.args![0], 0);
  }

  @handle(OPS.nextLineShowText)
  nextLineShowText(ctx: ProcessContext, assist: OperatorAssist) {
    if (!ctx.stateManager.state.font) {
      this.fontHandler.ensureStateFont(ctx.stateManager.state);
      return SKIP
    }
    ctx.textState!.carriageReturn();
    assist.buildTextContentItem(ctx.args![0], 0);
  }

  @handle(OPS.nextLineSetSpacingShowText)
  nextLineSetSpacingShowText(ctx: ProcessContext, assist: OperatorAssist) {
    if (!ctx.stateManager.state.font) {
      this.fontHandler.ensureStateFont(ctx.stateManager.state);
      return SKIP;
    }
    ctx.textState!.wordSpacing = ctx.args![0];
    ctx.textState!.charSpacing = ctx.args![1];
    ctx.textState!.carriageReturn();
    assist.buildTextContentItem(ctx.args![2], 0);
  }

  @handle(OPS.paintXObject)
  paintXObject(ctx: ProcessContext, assist: OperatorAssist) {
    assist.flushTextContentItem();
    if (!ctx.xobjs) {
      ctx.xobjs = ctx.resources.getValue(DictKey.XObject) || DictImpl.empty;
    }

    const isValidName = ctx.args![0] instanceof Name;
    const name = ctx.args![0].name;

    if (isValidName && ctx.emptyXObjectCache.getByName(name)) {
      return
    }

    ctx.next(new Promise<void>((resolveXObject, rejectXObject) => {
      if (!isValidName) {
        throw new FormatError("XObject must be referred to by name.");
      }
      let xobj = ctx.xobjs!.getRaw(name);
      if (xobj instanceof Ref) {
        if (ctx.emptyXObjectCache.getByRef(xobj)) {
          resolveXObject();
          return;
        }
        const globalImage = ctx.globalImageCache.getData(xobj, ctx.pageIndex);
        if (globalImage) {
          resolveXObject();
          return;
        }
        xobj = ctx.xref.fetch(xobj);
      }

      if (!(xobj instanceof BaseStream)) {
        throw new FormatError("XObject should be a stream");
      }
      const type = xobj.dict!.getValue(DictKey.Subtype);
      if (!(type instanceof Name)) {
        throw new FormatError("XObject should have a Name subtype");
      }

      if (type.name !== "Form") {
        ctx.emptyXObjectCache.set(name, xobj.dict!.objId, true);
        resolveXObject();
        return;
      }

      // Use a new `StateManager` to prevent incorrect positioning
      // of textItems *after* the Form XObject, since errors in the
      // data can otherwise prevent `restore` operators from
      // executing.
      // NOTE: Only an issue when `options.ignoreErrors === true`.
      const currentState = ctx.stateManager.state.clone();
      const xObjStateManager = new StateManager(currentState);

      const matrix = <TransformType | null>lookupMatrix(xobj.dict!.getArrayValue(DictKey.Matrix), null);
      if (matrix) {
        xObjStateManager.transform(matrix!);
      }

      // Enqueue the `textContent` chunk before parsing the /Form
      // XObject.
      assist.enqueueChunk();

      const sinkWrapper = new TextContentSinkProxy(ctx.sink);

      this.context.operatorFactory.createTextContentHandler(
        xobj, ctx.task, xobj.dict!.getValue(DictKey.Resources) || ctx.resources,
        sinkWrapper, ctx.viewBox, ctx.includeMarkedContent, ctx.keepWhiteSpace, ctx.seenStyles,
        xObjStateManager, ctx.lang, ctx.markedContentData, ctx.disableNormalization
      ).handle().then(() => {
        if (!sinkWrapper.enqueueInvoked) {
          ctx.emptyXObjectCache.set(name, xobj.dict!.objId, true);
        }
        resolveXObject();
      }, rejectXObject);
    }).catch(reason => {
      if (reason instanceof AbortException) {
        return;
      }
      if (ctx.options.ignoreErrors) {
        // Error(s) in the XObject -- allow text-extraction to
        // continue.
        warn(`getTextContent - ignoring XObject: "${reason}".`);
        return;
      }
      throw reason;
    }));
    return OVER
  }

  @handle(OPS.setGState)
  setGState(ctx: ProcessContext, assist: OperatorAssist) {
    const isValidName = ctx.args![0] instanceof Name;
    const name = ctx.args![0].name;

    if (isValidName && ctx.emptyGStateCache.getByName(name)) {
      return
    }

    ctx.next(new Promise((resolveGState, rejectGState) => {
      if (!isValidName) {
        throw new FormatError("GState must be referred to by name.");
      }

      const extGState = ctx.resources.getValue(DictKey.ExtGState);
      if (!(extGState instanceof DictImpl)) {
        throw new FormatError("ExtGState should be a dictionary.");
      }

      const gState = extGState.getValue(name);
      // TODO: Attempt to lookup cached GStates by reference as well,
      //       if and only if there are PDF documents where doing so
      //       would significantly improve performance.
      if (!(gState instanceof DictImpl)) {
        throw new FormatError("GState should be a dictionary.");
      }

      const gStateFont = <[Ref, number]>gState.getValue(DictKey.Font);
      if (!gStateFont) {
        ctx.emptyGStateCache.set(name, gState.objId!, true);
        resolveGState(undefined);
        return;
      }

      assist.flushTextContentItem();

      ctx.textState!.fontName = null;
      ctx.textState!.fontSize = gStateFont[1];
      assist.handleSetFont(null, gStateFont[0]).then(resolveGState, rejectGState);
    }).catch(function (reason) {
      if (reason instanceof AbortException) {
        return;
      }
      if (ctx.options.ignoreErrors) {
        // Error(s) in the ExtGState -- allow text-extraction to
        // continue.
        warn(`getTextContent - ignoring ExtGState: "${reason}".`);
        return;
      }
      throw reason;
    }));
    return OVER;
  }

  @handle(OPS.beginMarkedContent)
  beginMarkedContent(ctx: ProcessContext, assist: OperatorAssist) {
    assist.flushTextContentItem();
    if (ctx.includeMarkedContent) {
      ctx.markedContentData!.level++;

      ctx.textContent.items.push({
        type: "beginMarkedContent",
        id: null,
        tag: ctx.args![0] instanceof Name ? ctx.args![0].name : null,
      });
    }
  }

  @handle(OPS.beginMarkedContentProps)
  beginMarkedContentProps(ctx: ProcessContext, assist: OperatorAssist) {
    assist.flushTextContentItem();
    if (ctx.includeMarkedContent) {
      ctx.markedContentData!.level++;

      let mcid = null;
      if (ctx.args![1] instanceof DictImpl) {
        mcid = ctx.args![1].getValue(DictKey.MCID);
      }
      ctx.textContent.items.push({
        type: "beginMarkedContentProps",
        id: Number.isInteger(mcid)
          ? `${ctx.idFactory.getPageObjId()}_mc${mcid}`
          : null,
        tag: ctx.args![0] instanceof Name ? ctx.args![0].name : null,
      });
    }
  }

  @handle(OPS.endMarkedContent)
  endMarkedContent(ctx: ProcessContext, assist: OperatorAssist) {
    assist.flushTextContentItem();
    if (ctx.includeMarkedContent) {
      if (ctx.markedContentData!.level === 0) {
        // Handle unbalanced beginMarkedContent/endMarkedContent
        // operators (fixes issue15629.pdf).
        return
      }
      ctx.markedContentData!.level--;

      ctx.textContent.items.push({
        id: null, tag: null,
        type: "endMarkedContent",
      });
    }
  }

  @handle(OPS.restore)
  restore(ctx: ProcessContext, assist: OperatorAssist) {
    const previousState = ctx.previousState;
    const textState = ctx.textState!;
    if (
      previousState &&
      (previousState.font !== textState.font ||
        previousState.fontSize !== textState.fontSize ||
        previousState.fontName !== textState.fontName)
    ) {
      assist.flushTextContentItem();
    }
  }
}

const deferred = Promise.resolve();


/**
 * 一个handler代表着一次获取方法的执行。
 */
export class GetTextContentHandler implements OperatorListHandler {

  protected stream: BaseStream;

  protected task: WorkerTask;

  protected resources: Dict;

  protected sink: StreamSink<EvaluatorTextContent>;

  protected viewBox: number[];

  protected includeMarkedContent: boolean;

  protected keepWhiteSpace: boolean;

  protected seenStyles: Set<string>;

  protected stateManager: StateManager;

  protected lang: string | null;

  protected markedContent: { level: 0 } | null = null;

  protected disableNormalization: boolean;

  protected evalCtx: EvaluatorContext;

  protected operator: TextContentOperator;

  protected assist: OperatorAssist | null = null;

  constructor(
    evalCtx: EvaluatorContext,
    stream: BaseStream,
    task: WorkerTask,
    resources: Dict | null,
    sink: StreamSink<EvaluatorTextContent>,
    viewBox: number[],
    includeMarkedContent = false,
    keepWhiteSpace = false,
    seenStyles = new Set<string>(),
    stateManager: StateManager | null = null,
    lang: string | null = null,
    markedContentData: { level: 0 } | null = null,
    disableNormalization = false,
  ) {
    this.stream = stream;
    this.task = task;
    this.resources = resources ?? DictImpl.empty;
    this.sink = sink;
    this.viewBox = viewBox;
    this.includeMarkedContent = includeMarkedContent;
    this.keepWhiteSpace = keepWhiteSpace;
    this.seenStyles = seenStyles;
    this.stateManager = stateManager ?? new StateManager(new TextState());
    this.includeMarkedContent = includeMarkedContent;
    if (includeMarkedContent) {
      markedContentData ||= { level: 0 };
    }
    this.markedContent = markedContentData;
    this.lang = lang;
    this.disableNormalization = disableNormalization;
    this.evalCtx = evalCtx;
    this.operator = new TextContentOperator(evalCtx);
  }

  async handle(): Promise<void> {

    const preprocessor = new EvaluatorPreprocessor(this.stream, this.evalCtx.xref, this.stateManager);
    const handler = new Promise<void>((resolve, reject) => {
      const context: ProcessContext = {
        fn: null,
        args: null,
        textContent: {
          items: [],
          styles: new Map(),
          lang: this.lang,
        },
        textContentItem: {
          initialized: false,
          str: [],
          totalWidth: 0,
          totalHeight: 0,
          width: 0,
          height: 0,
          vertical: false,
          prevTransform: null,
          textAdvanceScale: 0,
          spaceInFlowMin: 0,
          spaceInFlowMax: 0,
          trackingSpaceMin: Infinity,
          negativeSpaceMax: -Infinity,
          notASpace: -Infinity,
          transform: null,
          fontName: null,
          hasEOL: false,
        },
        showSpacedTextBuffer: [],
        emptyXObjectCache: new LocalConditionCache(),
        emptyGStateCache: new LocalGStateCache(),
        globalImageCache: this.evalCtx.globalImageCache,
        textState: null,
        preprocessor,
        /**
         * 因为next需要用到assist相关的方法，因此不能够直接在这里初始化。
         * 直接将next设置为null也不合适，因为这会给后续的代码开发带来很多不必要的烦恼。
         * */
        next: () => { },
        includeMarkedContent: this.includeMarkedContent,
        pageIndex: this.evalCtx.pageIndex,
        resources: this.resources,
        stateManager: this.stateManager,
        timeSlotManager: new TimeSlotManager(),
        seenStyles: this.seenStyles,
        keepWhiteSpace: this.keepWhiteSpace,
        previousState: null,
        idFactory: undefined,
        options: this.evalCtx.options,
        markedContentData: this.markedContent,
        lang: this.lang,
        xref: this.evalCtx.xref,
        xobjs: null,
        sink: this.sink,
        viewBox: this.viewBox,
        task: this.task,
        disableNormalization: this.disableNormalization
      }

      this.assist = new OperatorAssist(context, this.evalCtx);
      context.next = (promise: Promise<unknown>) => {
        this.assist!.enqueueChunk(true);
        Promise.all([promise, this.sink.ready]).then(() => {
          try {
            this.process(resolve, reject, context, this.assist!);
          } catch (ex) {
            reject(ex);
          }
        }, reject);
      };
    });
    try {
      return await handler;
    } catch (reason) {
      if (reason instanceof AbortException) {
        return;
      }
      if (this.evalCtx.options.ignoreErrors) {
        // Error(s) in the TextContent -- allow text-extraction to continue.
        warn(`getTextContent - ignoring errors during "${this.task.name}" task: "${reason}".`);
        this.assist!.flushTextContentItem();
        this.assist!.enqueueChunk();
        return;
      }
      throw reason;
    }
  }

  process(
    resolve: (value: void | PromiseLike<void>) => void,
    _reject: (reason?: any) => void, ctx: ProcessContext,
    assist: OperatorAssist
  ): void {
    this.task.ensureNotTerminated();
    ctx.timeSlotManager.reset();

    let stop: boolean;
    let args: MutableArray<any> = [];
    while (!(stop = ctx.timeSlotManager.check())) {
      // The arguments parsed by read() are not used beyond this loop, so
      // we can reuse the same array on every iteration, thus avoiding
      // unnecessary allocations.
      ctx.args!.length = 0;
      ctx.args = args;
      if (!ctx.preprocessor.read(ctx)) {
        break;
      }

      ctx.previousState = ctx.textState;
      ctx.textState = <TextState>ctx.stateManager.state;
      assert(ctx.textState instanceof TextState, "textState应当是TextState类型");
      const ret = this.operator.execute(ctx.fn!, ctx, assist);
      if (ret === SKIP) {
        continue;
      }
      if (ret === OVER) {
        return;
      }
      if (ctx.textContent.items.length >= this.sink.desiredSize) {
        // Wait for ready, if we reach highWaterMark.
        stop = true;
        break;
      }
    }
    if (stop) {
      ctx.next(deferred);
      return;
    }

    assist.flushTextContentItem();
    assist.enqueueChunk();
    resolve();
  }
}