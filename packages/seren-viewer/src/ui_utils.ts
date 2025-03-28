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

import { RectType } from "seren-common";

export const DEFAULT_SCALE_VALUE = "auto";
export const DEFAULT_SCALE = 1;
export const DEFAULT_SCALE_DELTA = 1.1;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10.0;
export const UNKNOWN_SCALE = 0;
export const MAX_AUTO_SCALE = 1.25;
export const SCROLLBAR_PADDING = 40;
export const VERTICAL_PADDING = 5;

export enum RenderingStates {
  INITIAL = 0,
  RUNNING = 1,
  PAUSED = 2,
  FINISHED = 3,
};

export enum PresentationModeState {
  UNKNOWN = 0,
  NORMAL = 1,
  CHANGING = 2,
  FULLSCREEN = 3,
};

export enum SidebarView {
  UNKNOWN = -1,
  NONE = 0,
  THUMBS = 1, // Default value.
  OUTLINE = 2,
  ATTACHMENTS = 3,
  LAYERS = 4,
};

export enum TextLayerMode {
  DISABLE = 0,
  ENABLE = 1,
  ENABLE_PERMISSIONS = 2,
};

export enum ScrollMode {
  UNKNOWN = -1,
  VERTICAL = 0, // Default value.
  HORIZONTAL = 1,
  WRAPPED = 2,
  PAGE = 3,
};

export enum SpreadMode {
  UNKNOWN = -1,
  NONE = 0, // Default value.
  ODD = 1,
  EVEN = 2,
};

export enum CursorTool {
  SELECT = 0, // The default value.
  HAND = 1,
  ZOOM = 2,
};

// Used by `PDFViewerApplication`, and by the API unit-tests.
export const AutoPrintRegExp = /\bprint\s*\(/;

/**
 * Scrolls specified element into view of its parent.
 * @param element - The element to be visible.
 * @param spot - An object with optional top and left properties,
 *   specifying the offset from the top left edge.
 * @param spot.left
 * @param spot.top
 * @param scrollMatches - When scrolling search results into view,
 *   ignore elements that either: Contains marked content identifiers,
 *   or have the CSS-rule `overflow: hidden;` set. The default value is `false`.
 */
export function scrollIntoView(element: HTMLElement, spot: { top: number, left: number } | null, scrollMatches = false) {
  // Assuming offsetParent is available (it's not available when viewer is in
  // hidden iframe or object). We have to scroll: if the offsetParent is not set
  // producing the error. See also animationStarted.
  let parent = <HTMLElement | null>element.offsetParent;
  if (!parent) {
    console.error("offsetParent is not set -- cannot scroll");
    return;
  }
  let offsetY = element.offsetTop + element.clientTop;
  let offsetX = element.offsetLeft + element.clientLeft;
  while (
    (parent.clientHeight === parent.scrollHeight &&
      parent.clientWidth === parent.scrollWidth) ||
    (scrollMatches &&
      (parent.classList.contains("markedContent") ||
        getComputedStyle(parent).overflow === "hidden"))
  ) {
    offsetY += parent.offsetTop;
    offsetX += parent.offsetLeft;

    parent = <HTMLElement | null>parent.offsetParent;
    if (!parent) {
      return; // no need to scroll
    }
  }
  if (spot) {
    if (spot.top !== undefined) {
      offsetY += spot.top;
    }
    if (spot.left !== undefined) {
      offsetX += spot.left;
      parent.scrollLeft = offsetX;
    }
  }
  parent.scrollTop = offsetY;
}

interface State {
  right: boolean;
  down: boolean;
  lastX: number;
  lastY: number;
  _eventHandler: () => void;
}

/**
 * Helper function to start monitoring the scroll event and converting them into
 * PDF.js friendly one: with scroll debounce and scroll direction.
 */
export function watchScroll(viewAreaElement: HTMLDivElement, callback: (state: State) => void, abortSignal: AbortSignal | null = null) {
  const debounceScroll = () => {
    if (rAF) {
      return;
    }
    // schedule an invocation of scroll for next animation frame.
    rAF = window.requestAnimationFrame(function viewAreaElementScrolled() {
      rAF = null;
      const currentX = viewAreaElement.scrollLeft;
      const lastX = state.lastX;
      if (currentX !== lastX) {
        state.right = currentX > lastX;
      }
      state.lastX = currentX;
      const currentY = viewAreaElement.scrollTop;
      const lastY = state.lastY;
      if (currentY !== lastY) {
        state.down = currentY > lastY;
      }
      state.lastY = currentY;
      callback(state);
    });
  };

  const state = {
    right: true,
    down: true,
    lastX: viewAreaElement.scrollLeft,
    lastY: viewAreaElement.scrollTop,
    _eventHandler: debounceScroll,
  };

  let rAF: number | null = null;
  viewAreaElement.addEventListener("scroll", debounceScroll, {
    useCapture: true,
    signal: abortSignal!,
  });
  abortSignal?.addEventListener(
    "abort",
    () => window.cancelAnimationFrame(rAF!),
    { once: true }
  );
  return state;
}

/**
 * Helper function to parse query string (e.g. ?param1=value&param2=...).
 */
export function parseQueryString(query: string) {
  const params = new Map();
  for (const [key, value] of new URLSearchParams(query)) {
    params.set(key.toLowerCase(), value);
  }
  return params;
}

const InvisibleCharsRegExp = /[\x00-\x1F]/g;

export function removeNullCharacters(str: string, replaceInvisible = false) {
  if (!InvisibleCharsRegExp.test(str)) {
    return str;
  }
  if (replaceInvisible) {
    return str.replaceAll(InvisibleCharsRegExp, m => (m === "\x00" ? "" : " "));
  }
  return str.replaceAll("\x00", "");
}

/**
 * Use binary search to find the index of the first item in a given array which
 * passes a given condition. The items are expected to be sorted in the sense
 * that if the condition is true for one item in the array, then it is also true
 * for all following items.
 *
 * @returns Index of the first array element to pass the test, or |items.length| if no such element exists.
 */
export function binarySearchFirstItem<T>(items: T[], condition: (item: T) => boolean, start = 0) {
  let minIndex = start;
  let maxIndex = items.length - 1;

  if (maxIndex < 0 || !condition(items[maxIndex])) {
    return items.length;
  }
  if (condition(items[minIndex])) {
    return minIndex;
  }

  while (minIndex < maxIndex) {
    const currentIndex = (minIndex + maxIndex) >> 1;
    const currentItem = items[currentIndex];
    if (condition(currentItem)) {
      maxIndex = currentIndex;
    } else {
      minIndex = currentIndex + 1;
    }
  }
  return minIndex; /* === maxIndex */
}

/**
 *  Approximates float number as a fraction using Farey sequence (max order
 *  of 8).
 *  @param x - Positive float number.
 *  @returns Estimated fraction: the first array item is a numerator,
 *  the second one is a denominator. They are both natural numbers.
 */
export function approximateFraction(x: number): [number, number] {
  // Fast paths for int numbers or their inversions.
  if (Math.floor(x) === x) {
    return [x, 1];
  }
  const xinv = 1 / x;
  const limit = 8;
  if (xinv > limit) {
    return [1, limit];
  } else if (Math.floor(xinv) === xinv) {
    return [1, xinv];
  }

  const x_ = x > 1 ? xinv : x;
  // a/b and c/d are neighbours in Farey sequence.
  let a = 0;
  let b = 1;
  let c = 1;
  let d = 1;
  // Limiting search to order 8.
  while (true) {
    // Generating next term in sequence (order of q).
    const p = a + c;
    const q = b + d;
    if (q > limit) {
      break;
    }
    if (x_ <= p / q) {
      c = p;
      d = q;
    } else {
      a = p;
      b = q;
    }
  }
  let result: [number, number];
  // Select closest of the neighbours to x.
  if (x_ - a / b < c / d - x_) {
    result = x_ === x ? [a, b] : [b, a];
  } else {
    result = x_ === x ? [c, d] : [d, c];
  }
  return result;
}

/**
 * @param x - A positive number to round to a multiple of `div`.
 * @param div - A natural number.
 */
export function floorToDivide(x: number, div: number) {
  return x - (x % div);
}

/**
 * Gets the size of the specified page, converted from PDF units to inches.
 */
export function getPageSizeInches(view: RectType, userUnit: number, rotate: number) {
  const [x1, y1, x2, y2] = view;
  // We need to take the page rotation into account as well.
  const changeOrientation = rotate % 180 !== 0;

  const width = ((x2 - x1) / 72) * userUnit;
  const height = ((y2 - y1) / 72) * userUnit;

  return {
    width: changeOrientation ? height : width,
    height: changeOrientation ? width : height,
  };
}

/**
 * Helper function for getVisibleElements.
 *
 * @param index - initial guess at the first visible element
 * @param views - array of pages, into which `index` is an index
 * @param top - the top of the scroll pane
 * @returns less than or equal to `index` that is definitely at or
 *   before the first visible element in `views`, but not by too much. (Usually,
 *   this will be the first element in the first partially visible row in
 *   `views`, although sometimes it goes back one row further.)
 */
export function backtrackBeforeAllVisibleElements(index: number, views: { div: HTMLDivElement }[], top: number) {
  // binarySearchFirstItem's assumption is that the input is ordered, with only
  // one index where the conditions flips from false to true: [false ...,
  // true...]. With vertical scrolling and spreads, it is possible to have
  // [false ..., true, false, true ...]. With wrapped scrolling we can have a
  // similar sequence, with many more mixed true and false in the middle.
  //
  // So there is no guarantee that the binary search yields the index of the
  // first visible element. It could have been any of the other visible elements
  // that were preceded by a hidden element.

  // Of course, if either this element or the previous (hidden) element is also
  // the first element, there's nothing to worry about.
  if (index < 2) {
    return index;
  }

  // That aside, the possible cases are represented below.
  //
  //     ****  = fully hidden
  //     A*B*  = mix of partially visible and/or hidden pages
  //     CDEF  = fully visible
  //
  // (1) Binary search could have returned A, in which case we can stop.
  // (2) Binary search could also have returned B, in which case we need to
  // check the whole row.
  // (3) Binary search could also have returned C, in which case we need to
  // check the whole previous row.
  //
  // There's one other possibility:
  //
  //     ****  = fully hidden
  //     ABCD  = mix of fully and/or partially visible pages
  //
  // (4) Binary search could only have returned A.

  // Initially assume that we need to find the beginning of the current row
  // (case 1, 2, or 4), which means finding a page that is above the current
  // page's top. If the found page is partially visible, we're definitely not in
  // case 3, and this assumption is correct.
  let elt = views[index].div;
  let pageTop = elt.offsetTop + elt.clientTop;

  if (pageTop >= top) {
    // The found page is fully visible, so we're actually either in case 3 or 4,
    // and unfortunately we can't tell the difference between them without
    // scanning the entire previous row, so we just conservatively assume that
    // we do need to backtrack to that row. In both cases, the previous page is
    // in the previous row, so use its top instead.
    elt = views[index - 1].div;
    pageTop = elt.offsetTop + elt.clientTop;
  }

  // Now we backtrack to the first page that still has its bottom below
  // `pageTop`, which is the top of a page in the first visible row (unless
  // we're in case 4, in which case it's the row before that).
  // `index` is found by binary search, so the page at `index - 1` is
  // invisible and we can start looking for potentially visible pages from
  // `index - 2`. (However, if this loop terminates on its first iteration,
  // which is the case when pages are stacked vertically, `index` should remain
  // unchanged, so we use a distinct loop variable.)
  for (let i = index - 2; i >= 0; --i) {
    elt = views[i].div;
    if (elt.offsetTop + elt.clientTop + elt.clientHeight <= pageTop) {
      // We have reached the previous row, so stop now.
      // This loop is expected to terminate relatively quickly because the
      // number of pages per row is expected to be small.
      break;
    }
    index = i;
  }
  return index;
}

/**
 * Generic helper to find out what elements are visible within a scroll pane.
 *
 * Well, pretty generic. There are some assumptions placed on the elements
 * referenced by `views`:
 *   - If `horizontal`, no left of any earlier element is to the right of the
 *     left of any later element.
 *   - Otherwise, `views` can be split into contiguous rows where, within a row,
 *     no top of any element is below the bottom of any other element, and
 *     between rows, no bottom of any element in an earlier row is below the
 *     top of any element in a later row.
 *
 * (Here, top, left, etc. all refer to the padding edge of the element in
 * question. For pages, that ends up being equivalent to the bounding box of the
 * rendering canvas. Earlier and later refer to index in `views`, not page
 * layout.)
 * @param scrollEl - A container that can possibly scroll.
 * @param views - Objects with a `div` property that contains an
 *   HTMLElement, which should all be descendants of `scrollEl` satisfying the
 *   relevant layout assumptions.
 * @param sortByVisibility - If `true`, the returned elements are
 *   sorted in descending order of the percent of their padding box that is
 *   visible. The default value is `false`.
 * @param horizontal - If `true`, the elements are assumed to be
 *   laid out horizontally instead of vertically. The default value is `false`.
 * @param rtl - If `true`, the `scrollEl` container is assumed to
 *   be in right-to-left mode. The default value is `false`.
 */
export function getVisibleElements(
  scrollEl: HTMLElement,
  views: { div: HTMLDivElement, id: number }[],
  sortByVisibility = false,
  horizontal = false,
  rtl = false,
) {
  const top = scrollEl.scrollTop;
  const bottom = top + scrollEl.clientHeight;
  const left = scrollEl.scrollLeft;
  const right = left + scrollEl.clientWidth;

  // Throughout this "generic" function, comments will assume we're working with
  // PDF document pages, which is the most important and complex case. In this
  // case, the visible elements we're actually interested is the page canvas,
  // which is contained in a wrapper which adds no padding/border/margin, which
  // is itself contained in `view.div` which adds no padding (but does add a
  // border). So, as specified in this function's doc comment, this function
  // does all of its work on the padding edge of the provided views, starting at
  // offsetLeft/Top (which includes margin) and adding clientLeft/Top (which is
  // the border). Adding clientWidth/Height gets us the bottom-right corner of
  // the padding edge.
  function isElementBottomAfterViewTop(view: { div: HTMLDivElement }) {
    const element = view.div;
    const elementBottom = element.offsetTop + element.clientTop + element.clientHeight;
    return elementBottom > top;
  }

  function isElementNextAfterViewHorizontally(view: { div: HTMLDivElement }) {
    const element = view.div;
    const elementLeft = element.offsetLeft + element.clientLeft;
    const elementRight = elementLeft + element.clientWidth;
    return rtl ? elementLeft < right : elementRight > left;
  }

  const visible = [];
  const ids = new Set<number>();
  const numViews = views.length;
  let firstVisibleElementInd = binarySearchFirstItem(
    views, horizontal ? isElementNextAfterViewHorizontally : isElementBottomAfterViewTop
  );

  // Please note the return value of the `binarySearchFirstItem` function when
  // no valid element is found (hence the `firstVisibleElementInd` check below).
  if (
    firstVisibleElementInd > 0 &&
    firstVisibleElementInd < numViews &&
    !horizontal
  ) {
    // In wrapped scrolling (or vertical scrolling with spreads), with some page
    // sizes, isElementBottomAfterViewTop doesn't satisfy the binary search
    // condition: there can be pages with bottoms above the view top between
    // pages with bottoms below. This function detects and corrects that error;
    // see it for more comments.
    firstVisibleElementInd = backtrackBeforeAllVisibleElements(
      firstVisibleElementInd, views, top
    );
  }

  // lastEdge acts as a cutoff for us to stop looping, because we know all
  // subsequent pages will be hidden.
  //
  // When using wrapped scrolling or vertical scrolling with spreads, we can't
  // simply stop the first time we reach a page below the bottom of the view;
  // the tops of subsequent pages on the same row could still be visible. In
  // horizontal scrolling, we don't have that issue, so we can stop as soon as
  // we pass `right`, without needing the code below that handles the -1 case.
  let lastEdge = horizontal ? right : -1;

  for (let i = firstVisibleElementInd; i < numViews; i++) {
    const view = views[i], element = view.div;
    const currentWidth = element.offsetLeft + element.clientLeft;
    const currentHeight = element.offsetTop + element.clientTop;
    const viewWidth = element.clientWidth, viewHeight = element.clientHeight;
    const viewRight = currentWidth + viewWidth;
    const viewBottom = currentHeight + viewHeight;

    if (lastEdge === -1) {
      // As commented above, this is only needed in non-horizontal cases.
      // Setting lastEdge to the bottom of the first page that is partially
      // visible ensures that the next page fully below lastEdge is on the
      // next row, which has to be fully hidden along with all subsequent rows.
      if (viewBottom >= bottom) {
        lastEdge = viewBottom;
      }
    } else if ((horizontal ? currentWidth : currentHeight) > lastEdge) {
      break;
    }

    if (
      viewBottom <= top ||
      currentHeight >= bottom ||
      viewRight <= left ||
      currentWidth >= right
    ) {
      continue;
    }

    const hiddenHeight =
      Math.max(0, top - currentHeight) + Math.max(0, viewBottom - bottom);
    const hiddenWidth =
      Math.max(0, left - currentWidth) + Math.max(0, viewRight - right);

    const fractionHeight = (viewHeight - hiddenHeight) / viewHeight,
      fractionWidth = (viewWidth - hiddenWidth) / viewWidth;
    const percent = (fractionHeight * fractionWidth * 100) | 0;

    visible.push({
      id: view.id,
      x: currentWidth,
      y: currentHeight,
      view,
      percent,
      widthPercent: (fractionWidth * 100) | 0,
    });
    ids.add(view.id);
  }

  const first = visible[0], last = visible.at(-1);

  if (sortByVisibility) {
    visible.sort(function (a, b) {
      const pc = a.percent - b.percent;
      if (Math.abs(pc) > 0.001) {
        return -pc;
      }
      return a.id - b.id; // ensure stability
    });
  }
  return { first, last, views: visible, ids };
}

export function normalizeWheelEventDirection(evt: WheelEvent) {
  let delta = Math.hypot(evt.deltaX, evt.deltaY);
  const angle = Math.atan2(evt.deltaY, evt.deltaX);
  if (-0.25 * Math.PI < angle && angle < 0.75 * Math.PI) {
    // All that is left-up oriented has to change the sign.
    delta = -delta;
  }
  return delta;
}

export function normalizeWheelEventDelta(evt: WheelEvent) {
  const deltaMode = evt.deltaMode; // Avoid being affected by bug 1392460.
  let delta = normalizeWheelEventDirection(evt);

  const MOUSE_PIXELS_PER_LINE = 30;
  const MOUSE_LINES_PER_PAGE = 30;

  // Converts delta to per-page units
  if (deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    delta /= MOUSE_PIXELS_PER_LINE * MOUSE_LINES_PER_PAGE;
  } else if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    delta /= MOUSE_LINES_PER_PAGE;
  }
  return delta;
}

export function isValidRotation(angle: unknown) {
  return Number.isInteger(angle) && <number>angle % 90 === 0;
}

export function isValidScrollMode(mode: unknown): mode is ScrollMode {
  if (typeof mode !== 'number') {
    return false;
  }
  const values = Object.values(ScrollMode).filter(
    v => typeof v === 'number'
  )
  return values.includes(mode) && mode !== ScrollMode.UNKNOWN;
}

export function isValidSpreadMode(mode: unknown): mode is SpreadMode {
  if (typeof mode !== 'number') {
    return false;
  }
  const values = Object.values(SpreadMode).filter(
    v => typeof v === 'number'
  )
  return values.includes(mode) && mode !== SpreadMode.UNKNOWN;
}

export function isPortraitOrientation(size: { width: number, height: number }) {
  return size.width <= size.height;
}

/**
 * Promise that is resolved when DOM window becomes visible.
 */
export const animationStarted = new Promise(function (resolve) {
  window.requestAnimationFrame(resolve);
});

export const docStyle = document.documentElement.style;

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

export class ProgressBar {

  #classList: DOMTokenList;

  #disableAutoFetchTimeout: number | null = null;

  #percent = 0;

  #style: CSSStyleDeclaration;

  #visible = true;

  constructor(bar: HTMLElement) {
    this.#classList = bar.classList;
    this.#style = bar.style;
  }

  get percent() {
    return this.#percent;
  }

  set percent(val) {
    this.#percent = clamp(val, 0, 100);

    if (isNaN(val)) {
      this.#classList.add("indeterminate");
      return;
    }
    this.#classList.remove("indeterminate");

    this.#style.setProperty("--progressBar-percent", `${this.#percent}%`);
  }

  setWidth(viewer: HTMLElement | null) {
    if (!viewer) {
      return;
    }
    const container = <HTMLElement>viewer.parentNode;
    const scrollbarWidth = container.offsetWidth - viewer.offsetWidth;
    if (scrollbarWidth > 0) {
      this.#style.setProperty(
        "--progressBar-end-offset",
        `${scrollbarWidth}px`
      );
    }
  }

  setDisableAutoFetch(delay = /* ms = */ 5000) {
    if (this.#percent === 100 || isNaN(this.#percent)) {
      return;
    }
    if (this.#disableAutoFetchTimeout) {
      clearTimeout(this.#disableAutoFetchTimeout);
    }
    this.show();

    this.#disableAutoFetchTimeout = setTimeout(() => {
      this.#disableAutoFetchTimeout = null;
      this.hide();
    }, delay);
  }

  hide() {
    if (!this.#visible) {
      return;
    }
    this.#visible = false;
    this.#classList.add("hidden");
  }

  show() {
    if (this.#visible) {
      return;
    }
    this.#visible = true;
    this.#classList.remove("hidden");
  }
}

/**
 * Get the active or focused element in current DOM.
 *
 * Recursively search for the truly active or focused element in case there are
 * shadow DOMs.
 *
 * @returns {Element} the truly active or focused element.
 */
export function getActiveOrFocusedElement() {
  let curRoot: Document | ShadowRoot = document;
  let curActiveOrFocused =
    curRoot.activeElement || curRoot.querySelector(":focus");

  while (curActiveOrFocused?.shadowRoot) {
    curRoot = curActiveOrFocused.shadowRoot;
    curActiveOrFocused = curRoot.activeElement || curRoot.querySelector(":focus");
  }

  return curActiveOrFocused;
}

/**
 * Converts API PageLayout values to the format used by `BaseViewer`.
 * @param layout - The API PageLayout value.
 */
export function apiPageLayoutToViewerModes(layout: string) {
  let scrollMode = ScrollMode.VERTICAL;
  let spreadMode = SpreadMode.NONE;

  switch (layout) {
    case "SinglePage":
      scrollMode = ScrollMode.PAGE;
      break;
    case "OneColumn":
      break;
    case "TwoPageLeft":
      scrollMode = ScrollMode.PAGE;
    /* falls through */
    case "TwoColumnLeft":
      spreadMode = SpreadMode.ODD;
      break;
    case "TwoPageRight":
      scrollMode = ScrollMode.PAGE;
    /* falls through */
    case "TwoColumnRight":
      spreadMode = SpreadMode.EVEN;
      break;
  }
  return { scrollMode, spreadMode };
}

/**
 * Converts API PageMode values to the format used by `PDFSidebar`.
 * NOTE: There's also a "FullScreen" parameter which is not possible to support,
 *       since the Fullscreen API used in browsers requires that entering
 *       fullscreen mode only occurs as a result of a user-initiated event.
 * @param mode - The API PageMode value.
 * @returns A value from {SidebarView}.
 */
export function apiPageModeToSidebarView(mode: string): SidebarView {
  switch (mode) {
    case "UseNone":
      return SidebarView.NONE;
    case "UseThumbs":
      return SidebarView.THUMBS;
    case "UseOutlines":
      return SidebarView.OUTLINE;
    case "UseAttachments":
      return SidebarView.ATTACHMENTS;
    case "UseOC":
      return SidebarView.LAYERS;
  }
  return SidebarView.NONE; // Default value.
}

export function toggleCheckedBtn(button: HTMLButtonElement, toggle: boolean, view: HTMLElement | null = null) {
  button.classList.toggle("toggled", toggle);
  button.setAttribute("aria-checked", `${toggle}`);

  view?.classList.toggle("hidden", !toggle);
}

export function toggleExpandedBtn(button: HTMLButtonElement, toggle: boolean, view: HTMLElement | null = null) {
  button.classList.toggle("toggled", toggle);
  button.setAttribute("aria-expanded", `${toggle}`);

  view?.classList.toggle("hidden", !toggle);
}

// In Firefox, the css calc function uses f32 precision but the Chrome or Safari
// are using f64 one. So in order to have the same rendering in all browsers, we
// need to use the right precision in order to have correct dimensions.
// 这个地方需要仔细考量一下
export const calcRound = (function () {
  const e = document.createElement("div");
  e.style.width = "round(down, calc(1.6666666666666665 * 792px), 1px)";
  return e.style.width === "calc(1320px)" ? Math.fround : (x: number) => x;
})();
