import { DestinationType, RectType } from "../common/common_types";
import { Dict } from "../document/dict";
import { Name, Ref } from "../document/primitives";
import {
  AnnotationBorderStyleType,
  AnnotationEditorType,
  AnnotationType,
  assert,
  warn
} from "../utils/util";
import { PlatformHelper } from "../utils/platform_helper";
import { isNumberArray } from "../utils/util";
import { FileSpecSerializable } from "./message_handler_types";

export interface AnnotationEditorSerial {
  annotationType: AnnotationEditorType;
  oldAnnotation: Dict;
  ref: Ref;
  popupRef: string;
  deleted: boolean;
  id: string | null;
  structTreeParent: null;
  accessibilityData: {
    structParent: number;
    type: number;
  } | null;
  parentTreeId: number | null;
  bitmap: unknown;
  bitmapId: string | null;
  pageIndex: number;
}


export interface GetAnnotationsMessage {
  pageIndex: number;
  intent: number;
}

export interface FieldObject {
  id: string;
  page: number | null;
  type: string;
}

export interface PopupContent {
  str: string;
  html: {
    name: string;
    attributes: {
      dir: string;
      style: {
        fontSize: number,
        color: string,
      } | null
    };
    children: {
      name: string;
      children: PopupLine[];
    }[];
  };
}

/**
 * Contains all data regarding an annotation's border style.
 */
export class AnnotationBorderStyle {

  public width: number;

  public horizontalCornerRadius: number;

  public verticalCornerRadius: number;

  public style: number;

  public rawWidth: number;

  protected dashArray: number[];

  constructor() {
    this.width = 1;
    this.rawWidth = 1;
    this.style = AnnotationBorderStyleType.SOLID;
    this.dashArray = [3];
    this.horizontalCornerRadius = 0;
    this.verticalCornerRadius = 0;
  }

  noBorder() {
    this.width = 0;
    this.rawWidth = 0;
    this.dashArray = [];
    return this;
  }

  /**
   * Set the width.
   *
   * @public
   * @memberof AnnotationBorderStyle
   * @param width - The width.
   * @param rect - The annotation `Rect` entry.
   */
  setWidth(width: number | Name, rect: RectType = [0, 0, 0, 0]) {
    if (PlatformHelper.isTesting()) {
      assert(
        isNumberArray(rect, 4),
        "A valid `rect` parameter must be provided."
      );
    }

    // Some corrupt PDF generators may provide the width as a `Name`,
    // rather than as a number (fixes issue 10385).
    if (width instanceof Name) {
      this.width = 0; // This is consistent with the behaviour in Adobe Reader.
      return;
    }
    if (typeof width === "number") {
      if (width > 0) {
        this.rawWidth = width;
        const maxWidth = (rect[2] - rect[0]) / 2;
        const maxHeight = (rect[3] - rect[1]) / 2;

        // Ignore large `width`s, since they lead to the Annotation overflowing
        // the size set by the `Rect` entry thus causing the `annotationLayer`
        // to render it over the surrounding document (fixes bug1552113.pdf).
        if (
          maxWidth > 0 &&
          maxHeight > 0 &&
          (width > maxWidth || width > maxHeight)
        ) {
          warn(`AnnotationBorderStyle.setWidth - ignoring width: ${width}`);
          width = 1;
        }
      }
      this.width = width;
    }
  }

  /**
   * Set the style.
   *
   * @public
   * @memberof AnnotationBorderStyle
   * @param {Name} style - The annotation style.
   * @see {@link shared/util.ts}
   */
  setStyle(style: Name) {
    if (!(style instanceof Name)) {
      return;
    }
    switch (style.name) {
      case "S":
        this.style = AnnotationBorderStyleType.SOLID;
        break;

      case "D":
        this.style = AnnotationBorderStyleType.DASHED;
        break;

      case "B":
        this.style = AnnotationBorderStyleType.BEVELED;
        break;

      case "I":
        this.style = AnnotationBorderStyleType.INSET;
        break;

      case "U":
        this.style = AnnotationBorderStyleType.UNDERLINE;
        break;

      default:
        break;
    }
  }

  /**
   * Set the dash array.
   *
   * @public
   * @memberof AnnotationBorderStyle
   * @param dashArray - The dash array with at least one element
   * @param forceStyle
   */
  setDashArray(dashArray: number[], forceStyle = false) {
    // We validate the dash array, but we do not use it because CSS does not
    // allow us to change spacing of dashes. For more information, visit
    // http://www.w3.org/TR/css3-background/#the-border-style.
    if (Array.isArray(dashArray)) {
      // The PDF specification states that elements in the dash array, if
      // present, must be non-negative numbers and must not all equal zero.
      let isValid = true;
      let allZeros = true;
      for (const element of dashArray) {
        const validNumber = +element >= 0;
        if (!validNumber) {
          isValid = false;
          break;
        } else if (element > 0) {
          allZeros = false;
        }
      }
      if (dashArray.length === 0 || (isValid && !allZeros)) {
        this.dashArray = dashArray;

        if (forceStyle) {
          // Even though we cannot use the dash array in the display layer,
          // at least ensure that we use the correct border-style.
          this.setStyle(Name.get("D")!);
        }
      } else {
        this.width = 0; // Adobe behavior when the array is invalid.
      }
    } else if (dashArray) {
      this.width = 0; // Adobe behavior when the array is invalid.
    }
  }

  /**
   * Set the horizontal corner radius (from a Border dictionary).
   *
   * @public
   * @memberof AnnotationBorderStyle
   * @param {number} radius - The horizontal corner radius.
   */
  setHorizontalCornerRadius(radius: number) {
    if (Number.isInteger(radius)) {
      this.horizontalCornerRadius = radius;
    }
  }

  /**
   * Set the vertical corner radius (from a Border dictionary).
   *
   * @public
   * @memberof AnnotationBorderStyle
   * @param {number} radius - The vertical corner radius.
   */
  setVerticalCornerRadius(radius: number) {
    if (Number.isInteger(radius)) {
      this.verticalCornerRadius = radius;
    }
  }
}

export interface AnnotationData {
  richText: PopupContent | null;
  titleObj: StringObj | null;
  alternativeText: string | null;
  annotationFlags: number;
  borderStyle: AnnotationBorderStyle;
  // TODO 要再推断一下
  color: Uint8ClampedArray<ArrayBuffer> | null;
  backgroundColor: Uint8ClampedArray<ArrayBuffer> | null;
  borderColor: Uint8ClampedArray<ArrayBuffer> | null;
  rotation: number;
  contentsObj: StringObj;
  hasAppearance: boolean;
  id: string;
  modificationDate: string | null;
  rect: RectType | null;
  subtype: string | null;
  hasOwnCanvas: boolean;
  noRotate: boolean;
  noHTML: boolean;
  isEditable: boolean;
  structParent: number;
  kidIds?: string[]
  fieldName?: string
  pageIndex?: number;
  it?: string;
  quadPoints?: Float32Array<ArrayBuffer>;
  defaultAppearanceData?: {
    fontSize: number;
    fontName: string;
    fontColor: Uint8ClampedArray<ArrayBuffer>;
  };
  textPosition?: number[];
  textContent?: string[];
  actions?: Map<string, string[]>;
  annotationType?: AnnotationType;
  popupRef?: string | null;
  hidden?: boolean;
}

export interface StringObj {
  str: string;
  dir: string;
}

export interface PopupLine {
  name: string;
  value: string;
  attributes: {
    style: {
      color: any;
      fontSize: string;
    };
  };
}

export interface FreeTextEditorSerial extends AnnotationEditorSerial {
  color: Uint8ClampedArray<ArrayBuffer>;
  fontSize: number;
  rect: RectType;
  rotation: number;
  user: string;
  value: string;
}

export interface InkEditorSerial extends AnnotationEditorSerial {
  color: Uint8ClampedArray<ArrayBuffer>;
  opacity: number;
  rect: RectType;
  rotation: number;
  thickness: number;
  paths: { bezier: number[]; points: number[]; }[];
  outlines: {
    outline: number[];
    points: number[][];
  } | null;
}

export interface StampEditorSerial extends AnnotationEditorSerial {
  rect: RectType;
  rotation: number;
  user: string;
}

export interface HighlightEditorSerial extends AnnotationEditorSerial {
  color: Uint8ClampedArray<ArrayBuffer>;
  opacity: number;
  rect: RectType;
  rotation: number;
  user: string;
  quadPoints: number[];
  outlines: number[][];
}

export interface ButtonWidgetData extends WidgetData {
  multiSelect: boolean;
  buttonValue: string | null;
  exportValue: string | null;
  checkBox: boolean;
  radioButton: boolean;
  pushButton: boolean;
  isTooltipOnly: boolean;
  action: string;
  url: string;
  dest: string | DestinationType | null;
  annotationType: AnnotationType;
  setOCGState: {
    state: string[];
    preserveRB: boolean;
  };
  resetForm: {
    fields: string[];
    refs: string[];
    include: boolean;
  };
  actions: Map<string, string[]>;
  attachment: {
    content: Uint8Array<ArrayBuffer>;
    filename: string;
    description: string;
  };
  attachmentDest: string | null;
  newWindow: boolean;
}

export interface CaretData extends MarkupData {
  annotationType: AnnotationType;
}

export interface CircleData extends MarkupData {
  annotationType: AnnotationType;
}

export interface FileAttachmentData extends MarkupData {
  fillAlpha: number | null;
  name: string;
  file: FileSpecSerializable;
  annotationType: AnnotationType;
}

export interface FreeTextData extends MarkupData {
  annotationType: AnnotationType;

}

export interface HighlightData extends MarkupData {
  annotationType: AnnotationType;
  opacity: number;
}

export interface InkAnnotationData extends MarkupData {
  annotationType: AnnotationType;
  inkLists: Float32Array[];
  opacity: number;
}

export interface LineData extends MarkupData {
  lineEndings: string[];
  lineCoordinates: RectType;
  annotationType: AnnotationType;
}

export interface LinkData extends AnnotationData {
  annotationType: AnnotationType;
  setOCGState: {
    state: string[];
    preserveRB: boolean;
  };
  resetForm: {
    fields: string[];
    refs: string[];
    include: boolean;
  };
  actions: Map<string, string[]>;
  dest: string | DestinationType | null;
  attachment: {
    content: Uint8Array<ArrayBuffer>;
    filename: string;
    description: string;
  };
  attachmentDest: string | null;
  action: string;
  isTooltipOnly: boolean;
  url: string;
  newWindow: boolean;
}

export interface PolylineData extends MarkupData {
  annotationType: AnnotationType;
  vertices: Float32Array<ArrayBuffer> | null;
  lineEndings: string[];
}

export interface PopupData extends AnnotationData {
  open: boolean;
  annotationType: AnnotationType;
  parentRect: RectType;
}

export interface SquareData extends MarkupData {
  annotationType: AnnotationType;
}

export interface SquigglyData extends MarkupData {
  annotationType: AnnotationType;
}

export interface StampData extends MarkupData {
  annotationType: AnnotationType;
}

export interface StrikeOutData extends MarkupData {
  annotationType: AnnotationType;
}

export interface TextData extends MarkupData, WidgetData {
  stateModel: string | null;
  state: Name[] | null;
  annotationType: AnnotationType;
  name: string;
  hidden: boolean;
  titleObj: StringObj;
}

export interface UnderlineData extends MarkupData {
  annotationType: AnnotationType;
}

export interface WidgetData extends AnnotationData {
  doNotScroll: boolean;
  maxLen: number;
  textAlignment: number | null;
  comb: boolean;
  multiLine: boolean;
  options: {
    // 这两个值从静态代码分析的角度来看，是有可能是string[]的
    // 但根据代码的具体值来看，发现他们应该还是string类型的。
    exportValue: string | null;
    displayValue: string | null;
  }[] | null;
  combo: boolean | string | null;
  fieldValue: string | string[] | null;
  annotationType: AnnotationType;
  defaultFieldValue: string | string[] | null;
  fieldType: string | null;
  fieldFlags: number;
  hidden: boolean;
  required: boolean;
  readOnly: boolean;
}

export interface MarkupData extends AnnotationData {
  replyType: string;
  inReplyTo: string | null;
  titleObj: StringObj;
  creationDate: string | null;
}

