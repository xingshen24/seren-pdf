// 扩展 window 对象，添加 一些全局 属性
export declare global {

  interface Window {
    chrome?: boolean;
  }

  interface EventTarget {
    name: string;
  }

  interface CanvasRenderingContext2D {
    fillRule?: string;
  }

  interface CanvasRenderingContext2D {
    _removeMirroring?: () => void
    __originalSave?: () => void;
    __originalRestore?: () => void;
    __originalRotate?: (angle: number) => void;
    __originalScale?: (x: number, y: number) => void;
    __originalTranslate?: (x: number, y: number) => void;
    __originalTransform?: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    __originalSetTransform?: {
      (a: number, b: number, c: number, d: number, e: number, f: number): void;
      (transform?: DOMMatrix2DInit | undefined): void;
    };
    __originalResetTransform?: () => void;
    __originalClip?: {
      (fillRule?: CanvasFillRule | undefined): void;
      (path: Path2D, fillRule?: CanvasFillRule | undefined): void;
    }
    __originalMoveTo?: (x: number, y: number) => void;
    __originalLineTo?: (x: number, y: number) => void;
    __originalBezierCurveTo?: (cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) => void;
    __originalRect?: (x: number, y: number, w: number, h: number) => void;
    __originalClosePath?: () => void;
    __originalBeginPath?: () => void;
  }

  interface HTMLInputElement {
    exportValue?: string;
  }

  interface FocusOptions {
    focusVisible?: boolean;
  }

  interface AddEventListenerOptions {
    useCapture?: boolean;
  }

  
  declare var FontInspector = {
    enabled: boolean
  }
}