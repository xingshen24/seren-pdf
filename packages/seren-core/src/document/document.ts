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
  AnnotationEditorPrefix,
  assert,
  BaseException,
  FormatError,
  info,
  InvalidPDFException,
  isArrayEqual,
  PageActionEventType,
  RenderingIntentFlag,
  shadow,
  stringToBytes,
  stringToPDFString,
  toHexUtil,
  Util,
  warn,
  RectType,
  PlatformHelper,
  DictKey,
  isName,
  isRefsEqual,
  Name,
  Ref,
  RefSet,
  RefSetCache,
  Dict,
  MessageHandler,
  AnnotationEditorSerial,
  AnnotationData,
  EvaluatorTextContent,
  FieldObject,
  StreamSink,
  FontSubstitutionInfo,
  OpertaorListChunk,
  PDFDocumentInfo,
  StructTreeSerialNode,
  WorkerTask,
} from "seren-common";
import {
  Annotation,
  AnnotationFactory,
  AnnotationGlobals,
  PopupAnnotation,
  WidgetAnnotation,
} from "./annotation";
import { BaseStream } from "../stream/base_stream";
import { Catalog } from "./catalog";
import { clearGlobalCaches } from "../utils/cleanup_helper";
import {
  collectActions,
  getArrayInheritableProperty,
  getNewAnnotationsMap,
  isWhiteSpace,
  lookupNormalRect,
  MissingDataException,
  PDF_VERSION_REGEXP,
  XRefEntryException,
  XRefParseException
} from "../utils/core_utils";
import { calculateMD5 } from "../crypto/crypto";
import { StreamsSequenceStream } from "../stream/decode_stream";
import { EvaluatorCMapData, PartialEvaluator, TranslatedFont } from "../parser/evaluator/evaluator";
import { GlobalIdFactory, LocalIdFactory } from "../common/global_id_factory";
import { GlobalImageCache } from "../image/image_utils";
import { ObjectLoader } from "../common/object_loader";
import { OperatorList } from "../parser/operator_list";
import { Linearization, LinearizationInterface } from "../parser/parser";
import { PDFManager } from "../worker/pdf_manager";
import { NullStream, Stream } from "../stream/stream";
import { StructTreePage, StructTreeRoot } from "./struct_tree";
import { writeObject } from "../writer/writer";
import { XRefImpl } from "./xref";
import { DictImpl } from "./dict_impl";
import { CreateStampImageResult } from "../image/image_types";
import { isNull } from 'seren-common';

const DEFAULT_USER_UNIT = 1.0;
const LETTER_SIZE_MEDIABOX: RectType = [0, 0, 612, 792];

export class Page {

  protected pdfManager: PDFManager;

  protected pageIndex: number;

  public pageDict: Dict;

  public ref: Ref | null;

  protected fontCache: RefSetCache<string, Promise<TranslatedFont>>;

  protected fontKeyCache: Map<Dict, string>;

  protected builtInCMapCache: Map<string, EvaluatorCMapData>;

  protected standardFontDataCache: Map<string, Uint8Array<ArrayBuffer>>;

  protected globalImageCache: GlobalImageCache;

  protected xref: XRefImpl;

  protected systemFontCache: Map<string, FontSubstitutionInfo | null>;

  protected nonBlendModesSet: RefSet | null;

  protected evaluatorOptions;

  protected resourcesPromise: Promise<Dict> | null;

  protected _localIdFactory: LocalIdFactory;

  constructor(
    pdfManager: PDFManager,
    xref: XRefImpl,
    pageIndex: number,
    pageDict: Dict,
    ref: Ref | null,
    globalIdFactory: GlobalIdFactory,
    catalog: Catalog
  ) {
    this.pdfManager = pdfManager;
    this.pageIndex = pageIndex;
    this.pageDict = pageDict;
    this.xref = xref;
    this.ref = ref;
    this.fontCache = catalog.fontCache;
    this.fontKeyCache = catalog.fontKeyCache;
    this.builtInCMapCache = catalog.builtInCMapCache;
    this.standardFontDataCache = catalog.standardFontDataCache;
    this.globalImageCache = catalog.globalImageCache;
    this.systemFontCache = catalog.systemFontCache;
    this.nonBlendModesSet = catalog.nonBlendModesSet;
    this.evaluatorOptions = pdfManager.evaluatorOptions;
    this.resourcesPromise = null;
    const idCounters = { obj: 0 };
    // 匿名类
    this._localIdFactory = new LocalIdFactory(globalIdFactory, pageIndex, idCounters, ref!);
  }

  /**
   * @private
   */
  _getInheritableProperty(key: DictKey, getArray = false) {
    const value = getArrayInheritableProperty(
      this.pageDict, key, getArray
    );
    if (!Array.isArray(value)) {
      return value;
    }
    if (value.length === 1 || !(value[0] instanceof DictImpl)) {
      return value[0];
    }
    return DictImpl.merge(this.xref, <Dict[]>value, false);
  }

  get content() {
    return this.pageDict.getArrayValue(DictKey.Contents);
  }

  get resources() {
    // For robustness: The spec states that a \Resources entry has to be
    // present, but can be empty. Some documents still omit it; in this case
    // we return an empty dictionary.
    const resources = this._getInheritableProperty(DictKey.Resources);
    return shadow(this, "resources", resources instanceof DictImpl ? resources : DictImpl.empty);
  }

  _getBoundingBox(name: DictKey): RectType | null {
    const box = lookupNormalRect(<RectType>this._getInheritableProperty(name, true), null);

    if (box) {
      if (box[2] - box[0] > 0 && box[3] - box[1] > 0) {
        return box;
      }
      warn(`Empty, or invalid, /${name} entry.`);
    }
    return null;
  }

  get mediaBox(): RectType {
    // Reset invalid media box to letter size.
    return shadow(this, "mediaBox", this._getBoundingBox(DictKey.MediaBox) || LETTER_SIZE_MEDIABOX);
  }

  get cropBox() {
    // Reset invalid crop box to media box.
    return shadow(this, "cropBox", this._getBoundingBox(DictKey.CropBox) || this.mediaBox);
  }

  get userUnit() {
    let obj = this.pageDict.getValue(DictKey.UserUnit);
    if (typeof obj !== "number" || obj <= 0) {
      obj = DEFAULT_USER_UNIT;
    }
    return shadow(this, "userUnit", obj);
  }

  get view() {
    // From the spec, 6th ed., p.963:
    // "The crop, bleed, trim, and art boxes should not ordinarily
    // extend beyond the boundaries of the media box. If they do, they are
    // effectively reduced to their intersection with the media box."
    const { cropBox, mediaBox } = this;

    if (cropBox !== mediaBox && !isArrayEqual(cropBox, mediaBox)) {
      const box = Util.intersect(cropBox, mediaBox);
      if (box && box[2] - box[0] > 0 && box[3] - box[1] > 0) {
        return shadow(this, "view", box);
      }
      warn("Empty /CropBox and /MediaBox intersection.");
    }
    return shadow(this, "view", mediaBox);
  }

  get rotate() {
    let rotate = <number>this._getInheritableProperty(DictKey.Rotate) || 0;

    // Normalize rotation so it's a multiple of 90 and between 0 and 270.
    if (rotate % 90 !== 0) {
      rotate = 0;
    } else if (rotate >= 360) {
      rotate %= 360;
    } else if (rotate < 0) {
      // The spec doesn't cover negatives. Assume it's counterclockwise
      // rotation. The following is the other implementation of modulo.
      rotate = ((rotate % 360) + 360) % 360;
    }
    return shadow(this, "rotate", rotate);
  }

  /**
   * @private
   */
  _onSubStreamError(reason: unknown, objId: string | null) {
    if (this.evaluatorOptions.ignoreErrors) {
      warn(`getContentStream - ignoring sub-stream (${objId}): "${reason}".`);
      return;
    }
    throw reason;
  }

  /**
   * @returns {Promise<BaseStream>}
   */
  getContentStream(): Promise<BaseStream> {
    return this.pdfManager.ensure(this, (page) => page.content)
      .then((content: BaseStream | ArrayLike<unknown> | unknown) => {
        if (content instanceof BaseStream) {
          return content;
        }
        if (Array.isArray(content)) {
          return new StreamsSequenceStream(
            content, this._onSubStreamError.bind(this)
          );
        }
        // Replace non-existent page content with empty content.
        return new NullStream();
      }) as Promise<BaseStream>;
  }


  async #replaceIdByRef(annotations: AnnotationEditorSerial[], deletedAnnotations: RefSetCache<Ref, Ref> | RefSet, existingAnnotations: RefSet | null) {
    const promises = [];
    for (const annotation of annotations) {
      if (annotation.id) {
        const ref = Ref.fromString(annotation.id);
        if (!ref) {
          warn(`A non-linked annotation cannot be modified: ${annotation.id}`);
          continue;
        }
        if (annotation.deleted) {
          deletedAnnotations.put(ref, ref);
          if (annotation.popupRef) {
            const popupRef = Ref.fromString(annotation.popupRef);
            if (popupRef) {
              deletedAnnotations.put(popupRef, popupRef);
            }
          }
          continue;
        }
        existingAnnotations?.put(ref);
        annotation.ref = ref;
        promises.push(
          this.xref.fetchAsync(ref).then(
            (obj: Dict | unknown) => {
              if (obj instanceof DictImpl) {
                annotation.oldAnnotation = obj.clone();
              }
            },
            () => {
              warn(`Cannot fetch \`oldAnnotation\` for: ${ref}.`);
            }
          )
        );
        annotation.id = null;
      }
    }
    await Promise.all(promises);
  }

  async saveNewAnnotations(
    handler: MessageHandler, task: WorkerTask, annotations: AnnotationEditorSerial[],
    imagePromises: Map<string, Promise<CreateStampImageResult>> | null
  ) {
    const partialEvaluator = new PartialEvaluator(
      this.xref,
      handler,
      this.pageIndex,
      this._localIdFactory,
      this.fontCache,
      this.fontKeyCache,
      this.builtInCMapCache,
      this.standardFontDataCache,
      this.globalImageCache,
      this.systemFontCache,
      this.evaluatorOptions
    );

    const deletedAnnotations = new RefSetCache<Ref, Ref>();
    const existingAnnotations = new RefSet();
    await this.#replaceIdByRef(
      annotations, deletedAnnotations, existingAnnotations
    );

    const pageDict = this.pageDict;
    const annotationsArray = this.annotations.filter(
      a => !(a instanceof Ref && deletedAnnotations.has(a))
    );
    const newData = await AnnotationFactory.saveNewAnnotations(
      partialEvaluator, task, annotations, imagePromises
    );

    for (const { ref } of newData.annotations) {
      // Don't add an existing annotation ref to the annotations array.
      if (ref instanceof Ref && !existingAnnotations.has(ref)) {
        annotationsArray.push(ref);
      }
    }

    const savedDict = pageDict.getValue(DictKey.Annots);
    pageDict.set(DictKey.Annots, annotationsArray);
    const buffer = <string[]>[];
    await writeObject(this.ref!, pageDict, buffer, this.xref.encrypt);
    if (savedDict) {
      pageDict.set(DictKey.Annots, savedDict);
    }

    const objects = newData.dependencies;
    objects.push(
      { ref: this.ref!, data: buffer.join("") },
      ...newData.annotations
    );
    for (const deletedRef of deletedAnnotations) {
      objects.push({ ref: deletedRef, data: null });
    }

    return objects;
  }

  async save(
    handler: MessageHandler,
    task: WorkerTask,
    annotationStorage: Map<string, AnnotationEditorSerial> | null
  ) {
    const partialEvaluator = new PartialEvaluator(
      this.xref,
      handler,
      this.pageIndex,
      this._localIdFactory,
      this.fontCache,
      this.fontKeyCache,
      this.builtInCMapCache,
      this.standardFontDataCache,
      this.globalImageCache,
      this.systemFontCache,
      this.evaluatorOptions,
    );

    // Fetch the page's annotations and save the content
    // in case of interactive form fields.
    return this._parsedAnnotations.then(async annotations => {
      const newRefsPromises = [];
      for (const annotation of annotations) {
        newRefsPromises.push(annotation.save(partialEvaluator, task, annotationStorage).catch(reason => {
          warn(`save - ignoring annotation data during ${task.name} task:${reason}.`);
          return null;
        }));
      }
      return Promise.all(newRefsPromises).then(newRefs => {
        return newRefs.filter(newRef => !!newRef);
      });
    });
  }

  async loadResources(keys: string[]) {
    // TODO: add async `_getInheritableProperty` and remove this.
    this.resourcesPromise ||= <Promise<Dict>>this.pdfManager.ensure(this, (p) => p.resources);

    return this.resourcesPromise.then(() => {
      const objectLoader = new ObjectLoader(this.resources, keys, this.xref);
      return objectLoader.load();
    });
  }

  async getOperatorList(
    handler: MessageHandler,
    sink: StreamSink<OpertaorListChunk>,
    task: WorkerTask,
    intent: number,
    cacheKey: string,
    annotationStorage: Map<string, AnnotationEditorSerial> | null = null,
    modifiedIds: Set<string> | null = null,
  ) {
    const contentStreamPromise = this.getContentStream();
    const resourcesPromise = this.loadResources([
      "ColorSpace",
      "ExtGState",
      "Font",
      "Pattern",
      "Properties",
      "Shading",
      "XObject",
    ]);

    const partialEvaluator = new PartialEvaluator(
      this.xref,
      handler,
      this.pageIndex,
      this._localIdFactory,
      this.fontCache,
      this.fontKeyCache,
      this.builtInCMapCache,
      this.standardFontDataCache,
      this.globalImageCache,
      this.systemFontCache,
      this.evaluatorOptions,
    );

    const newAnnotsByPage = getNewAnnotationsMap(annotationStorage)
    const newAnnots = newAnnotsByPage?.get(this.pageIndex);
    let newAnnotationsPromise: Promise<Annotation<AnnotationData>[] | null> = Promise.resolve(null);
    let deletedAnnotations = null;

    if (newAnnots) {
      const annotationGlobalsPromise = this.pdfManager.ensureDoc(doc => doc.annotationGlobals);
      let imagePromises;

      // An annotation can contain a reference to a bitmap, but this bitmap
      // is defined in another annotation. So we need to find this annotation
      // and generate the bitmap.
      const missingBitmaps = new Set();
      for (const { bitmapId, bitmap } of newAnnots) {
        if (bitmapId && !bitmap && !missingBitmaps.has(bitmapId)) {
          missingBitmaps.add(bitmapId);
        }
      }

      const { isOffscreenCanvasSupported } = this.evaluatorOptions;
      if (missingBitmaps.size > 0) {
        const annotationWithBitmaps = newAnnots.slice();
        for (const [key, annotation] of annotationStorage!) {
          if (!key.startsWith(AnnotationEditorPrefix)) {
            continue;
          }
          if (annotation.bitmap && missingBitmaps.has(annotation.bitmapId)) {
            annotationWithBitmaps.push(annotation);
          }
        }
        // The array annotationWithBitmaps cannot be empty: the check above
        // makes sure to have at least one annotation containing the bitmap.
        imagePromises = AnnotationFactory.generateImages(
          annotationWithBitmaps,
          this.xref,
          isOffscreenCanvasSupported
        );
      } else {
        imagePromises = AnnotationFactory.generateImages(
          newAnnots,
          this.xref,
          isOffscreenCanvasSupported
        );
      }

      deletedAnnotations = new RefSet();

      newAnnotationsPromise = Promise.all([
        annotationGlobalsPromise,
        this.#replaceIdByRef(newAnnots, deletedAnnotations, null),
      ]).then(([annotationGlobals]) => {
        if (!annotationGlobals) {
          return null;
        }

        return AnnotationFactory.printNewAnnotations(
          annotationGlobals,
          partialEvaluator,
          task,
          newAnnots,
          imagePromises
        );
      });
    }

    const pageListPromise = Promise.all([
      contentStreamPromise,
      resourcesPromise,
    ]).then(async ([contentStream]) => {
      const opList = new OperatorList(intent, sink);
      const hasBlendModes = partialEvaluator.hasBlendModes(this.resources, this.nonBlendModesSet!);
      handler.StartRenderPage(hasBlendModes, this.pageIndex, cacheKey);
      return partialEvaluator.getOperatorList(contentStream, task, this.resources, opList).then(() => opList);
    });

    // Fetch the page's annotations and add their operator lists to the
    // page's operator list to render them.
    return Promise.all([
      pageListPromise, this._parsedAnnotations, newAnnotationsPromise,
    ]).then(([pageOpList, annotations, newAnnotations]) => {
      if (newAnnotations) {
        // Some annotations can already exist (if it has the refToReplace
        // property). In this case, we replace the old annotation by the new
        // one.
        annotations = annotations.filter(
          a => !(a.ref && deletedAnnotations!.has(a.ref))
        );
        for (let i = 0, ii = newAnnotations.length; i < ii; i++) {
          const newAnnotation = newAnnotations[i];
          if (newAnnotation.refToReplace) {
            const j = annotations.findIndex(
              a => a.ref && isRefsEqual(a.ref, newAnnotation.refToReplace!)
            );
            if (j >= 0) {
              annotations.splice(j, 1, newAnnotation);
              newAnnotations.splice(i--, 1);
              ii--;
            }
          }
        }
        annotations = annotations.concat(newAnnotations);
      }
      if (
        annotations.length === 0 ||
        intent & RenderingIntentFlag.ANNOTATIONS_DISABLE
      ) {
        pageOpList.flush(true);
        return { length: pageOpList.totalLength };
      }
      const renderForms = !!(intent & RenderingIntentFlag.ANNOTATIONS_FORMS),
        isEditing = !!(intent & RenderingIntentFlag.IS_EDITING),
        intentAny = !!(intent & RenderingIntentFlag.ANY),
        intentDisplay = !!(intent & RenderingIntentFlag.DISPLAY),
        intentPrint = !!(intent & RenderingIntentFlag.PRINT);

      // Collect the operator list promises for the annotations. Each promise
      // is resolved with the complete operator list for a single annotation.
      const opListPromises = <Promise<{
        opList: OperatorList | null;
        separateForm: boolean;
        separateCanvas: boolean;
      }>[]>[];
      for (const annotation of annotations) {
        if (
          intentAny ||
          (intentDisplay &&
            annotation.mustBeViewed(annotationStorage, renderForms) &&
            annotation.mustBeViewedWhenEditing(isEditing, modifiedIds)) ||
          (intentPrint && annotation.mustBePrinted(annotationStorage))
        ) {
          const opListPromise = annotation.getOperatorList(
            partialEvaluator, task, intent, annotationStorage
          );
          const catchPromise = opListPromise.catch(reason => {
            warn(
              "getOperatorList - ignoring annotation data during " +
              `"${task.name}" task: "${reason}".`
            );
            return { opList: null, separateForm: false, separateCanvas: false };
          });
          opListPromises.push(catchPromise);
        }
      }

      return Promise.all(opListPromises).then(opLists => {
        let form = false;
        let canvas = false;

        for (const { opList, separateForm, separateCanvas } of opLists) {
          pageOpList.addOpList(opList!);

          form ||= separateForm;
          canvas ||= separateCanvas;
        }
        pageOpList.flush(true, { form, canvas });
        return { length: pageOpList.totalLength };
      });
    });
  }

  async extractTextContent(
    handler: MessageHandler,
    task: WorkerTask,
    includeMarkedContent: boolean,
    disableNormalization: boolean,
    sink: StreamSink<EvaluatorTextContent>
  ) {
    const contentStreamPromise = this.getContentStream();
    const resources = ["ExtGState", "Font", "Properties", "XObject"]
    const resourcesPromise = this.loadResources(resources);
    const langPromise = this.pdfManager.ensureCatalog(catalog => catalog.lang);

    const [contentStream, , lang] = await Promise.all([
      contentStreamPromise, resourcesPromise, langPromise,
    ]);
    const partialEvaluator = new PartialEvaluator(
      this.xref,
      handler,
      this.pageIndex,
      this._localIdFactory,
      this.fontCache,
      this.fontKeyCache,
      this.builtInCMapCache,
      this.standardFontDataCache,
      this.globalImageCache,
      this.systemFontCache,
      this.evaluatorOptions,
    );

    return partialEvaluator.getTextContent(
      contentStream, task, this.resources, sink, this.view, includeMarkedContent,
      false, new Set(), null, lang, null, disableNormalization
    );
  }

  async getStructTree(): Promise<StructTreeSerialNode | null> {

    const structTreeRoot = await this.pdfManager.ensureCatalog(catalog => catalog.structTreeRoot);

    if (!structTreeRoot) {
      return null;
    }
    // Ensure that the structTree will contain the page's annotations.
    await this._parsedAnnotations;

    const structTree = await this.pdfManager.ensure(
      this, p => p._parseStructTree(structTreeRoot)
    );
    return this.pdfManager.ensure(structTree, t => t.serializable);
  }

  /**
   * @private
   */
  _parseStructTree(structTreeRoot: StructTreeRoot) {
    const tree = new StructTreePage(structTreeRoot, this.pageDict);
    tree.parse(this.ref!);
    return tree;
  }

  async getAnnotationsData(handler: MessageHandler, task: WorkerTask, intent: number) {
    const annotationsData: AnnotationData[] = [];
    const annotations = await this._parsedAnnotations;
    if (annotations.length === 0) {
      // 返回空数组
      return annotationsData;
    }

    const textContentPromises = [];
    let partialEvaluator;

    const intentAny = !!(intent & RenderingIntentFlag.ANY),
      intentDisplay = !!(intent & RenderingIntentFlag.DISPLAY),
      intentPrint = !!(intent & RenderingIntentFlag.PRINT);

    for (const annotation of annotations) {
      // Get the annotation even if it's hidden because
      // JS can change its display.
      const isVisible = intentAny || (intentDisplay && annotation.viewable);
      if (isVisible || (intentPrint && annotation.printable)) {
        annotationsData.push(annotation.data);
      }

      if (annotation.hasTextContent && isVisible) {
        partialEvaluator ||= new PartialEvaluator(
          this.xref,
          handler,
          this.pageIndex,
          this._localIdFactory,
          this.fontCache,
          this.fontKeyCache,
          this.builtInCMapCache,
          this.standardFontDataCache,
          this.globalImageCache,
          this.systemFontCache,
          this.evaluatorOptions,
        );

        textContentPromises.push(
          annotation.extractTextContent(
            partialEvaluator, task, [-Infinity, -Infinity, Infinity, Infinity]
          ).catch(function (reason: unknown) {
            warn(
              `getAnnotationsData - ignoring textContent during "${task.name}" task: "${reason}".`
            );
          })
        );
      }
    }

    await Promise.all(textContentPromises);
    return annotationsData;
  }

  // annts里肯定不止Ref，但是目前我们先当它是Ref[]
  get annotations() {
    const annots = this._getInheritableProperty(DictKey.Annots);
    return shadow(this, "annotations", Array.isArray(annots) ? annots : []);
  }

  get _parsedAnnotations() {
    const promise = (<Promise<Ref[]>>this.pdfManager.ensure(this, p => p.annotations)).then(async annots => {
      if (annots.length === 0) {
        return annots;
      }

      const [annotationGlobals, fieldObjects] = await Promise.all([
        this.pdfManager.ensureDoc(doc => doc.annotationGlobals),
        this.pdfManager.ensureDoc(doc => doc.fieldObjects),
      ]);
      if (!annotationGlobals) {
        return [];
      }

      const orphanFields = fieldObjects?.orphanFields ?? null;
      const annotationPromises: Promise<Annotation<AnnotationData> | null>[] = [];
      for (const annotationRef of annots) {
        annotationPromises.push(AnnotationFactory.create(
          this.xref, annotationRef, annotationGlobals, this._localIdFactory, false, orphanFields, this.ref
        ).catch(reason => {
          warn(`_parsedAnnotations: "${reason}".`);
          return null;
        }));
      }

      const sortedAnnotations = [];
      let popupAnnotations, widgetAnnotations;
      // Ensure that PopupAnnotations are handled last, since they depend on
      // their parent Annotation in the display layer; fixes issue 11362.
      for (const annotation of await Promise.all(annotationPromises)) {
        if (!annotation) {
          continue;
        }
        if (annotation instanceof WidgetAnnotation) {
          (widgetAnnotations ||= []).push(annotation);
          continue;
        }
        if (annotation instanceof PopupAnnotation) {
          (popupAnnotations ||= []).push(annotation);
          continue;
        }
        sortedAnnotations.push(annotation);
      }
      if (widgetAnnotations) {
        sortedAnnotations.push(...widgetAnnotations);
      }
      if (popupAnnotations) {
        sortedAnnotations.push(...popupAnnotations);
      }

      return sortedAnnotations;
    });

    return shadow(this, "_parsedAnnotations", <Promise<Annotation<AnnotationData>[]>>promise);
  }

  get jsActions() {
    const actions = collectActions(
      this.xref,
      this.pageDict,
      PageActionEventType
    );
    return shadow(this, "jsActions", actions);
  }
}

const PDF_HEADER_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const STARTXREF_SIGNATURE = new Uint8Array([
  0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66,
]);
const ENDOBJ_SIGNATURE = new Uint8Array([0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a]);

function find(stream: Stream, signature: Uint8Array, limit = 1024, backwards = false) {
  if (!PlatformHelper.hasDefined() || PlatformHelper.isTesting()) {
    assert(limit > 0, 'The "limit" must be a positive integer.');
  }
  const signatureLength = signature.length;

  const scanBytes = stream.peekBytes(limit);
  const scanLength = scanBytes.length - signatureLength;

  if (scanLength <= 0) {
    return false;
  }
  if (backwards) {
    const signatureEnd = signatureLength - 1;

    let pos = scanBytes.length - 1;
    while (pos >= signatureEnd) {
      let j = 0;
      while (
        j < signatureLength &&
        scanBytes[pos - j] === signature[signatureEnd - j]
      ) {
        j++;
      }
      if (j >= signatureLength) {
        // `signature` found.
        stream.pos += pos - signatureEnd;
        return true;
      }
      pos--;
    }
  } else {
    // forwards
    let pos = 0;
    while (pos <= scanLength) {
      let j = 0;
      while (j < signatureLength && scanBytes[pos + j] === signature[j]) {
        j++;
      }
      if (j >= signatureLength) {
        // `signature` found.
        stream.pos += pos;
        return true;
      }
      pos++;
    }
  }
  return false;
}

/**
 * The `PDFDocument` class holds all the (worker-thread) data of the PDF file.
 */
export class PDFDocument {

  protected pdfManager: PDFManager;

  protected stream: Stream;

  public xref: XRefImpl;

  protected _pagePromises: Map<number, Promise<Page>>;

  public catalog: Catalog | null = null;

  protected _version: string | null;

  protected _globalIdFactory: GlobalIdFactory;

  constructor(pdfManager: PDFManager, stream: Stream) {

    if (stream.length <= 0) {
      throw new InvalidPDFException("The PDF file is empty, i.e. its size is zero bytes.");
    }

    this.pdfManager = pdfManager;
    this.stream = stream;
    this.xref = new XRefImpl(stream, pdfManager);
    this._pagePromises = new Map();
    this._version = null;

    const idCounters = { font: 0 };
    this._globalIdFactory = new GlobalIdFactory(pdfManager, idCounters);
  }

  parse(recoveryMode: boolean) {
    this.xref.parse(recoveryMode);
    this.catalog = new Catalog(this.pdfManager, this.xref);
  }

  get linearization(): LinearizationInterface | null {
    let linearization = null;
    try {
      linearization = Linearization.create(this.stream);
    } catch (err: unknown) {
      if (err instanceof MissingDataException) {
        throw err;
      }
      info(err);
    }
    return shadow(this, "linearization", linearization);
  }

  get startXRef() {
    const stream = this.stream;
    let startXRef = 0;

    if (this.linearization) {
      // Find the end of the first object.
      stream.reset();
      if (find(stream, ENDOBJ_SIGNATURE)) {
        stream.skip(6);

        let ch = stream.peekByte();
        while (isWhiteSpace(ch)) {
          stream.pos++;
          ch = stream.peekByte();
        }
        startXRef = stream.pos - stream.start;
      }
    } else {
      // Find `startxref` by checking backwards from the end of the file.
      const step = 1024;
      const startXRefLength = STARTXREF_SIGNATURE.length;
      let found = false,
        pos = stream.end;

      while (!found && pos > 0) {
        pos -= step - startXRefLength;
        if (pos < 0) {
          pos = 0;
        }
        stream.pos = pos;
        found = find(stream, STARTXREF_SIGNATURE, step, true);
      }

      if (found) {
        stream.skip(9);
        let ch;
        do {
          ch = stream.getByte();
        } while (isWhiteSpace(ch));
        let str = "";
        while (ch >= /* Space = */ 0x20 && ch <= /* '9' = */ 0x39) {
          str += String.fromCharCode(ch);
          ch = stream.getByte();
        }
        startXRef = parseInt(str, 10);
        if (isNaN(startXRef)) {
          startXRef = 0;
        }
      }
    }
    return shadow(this, "startXRef", startXRef);
  }

  // Find the header, get the PDF format version and setup the
  // stream to start from the header.
  checkHeader() {
    const stream = this.stream;
    stream.reset();

    if (!find(stream, PDF_HEADER_SIGNATURE)) {
      // May not be a PDF file, but don't throw an error and let
      // parsing continue.
      return;
    }
    stream.moveStart();

    // Skip over the "%PDF-" prefix, since it was found above.
    stream.skip(PDF_HEADER_SIGNATURE.length);
    // Read the PDF format version.
    let version = "",
      ch;
    while (
      (ch = stream.getByte()) > /* Space = */ 0x20 &&
      version.length < /* MAX_PDF_VERSION_LENGTH = */ 7
    ) {
      version += String.fromCharCode(ch);
    }

    if (PDF_VERSION_REGEXP.test(version)) {
      this._version = version;
    } else {
      warn(`Invalid PDF header version: ${version}`);
    }
  }

  parseStartXRef() {
    this.xref.setStartXRef(this.startXRef);
  }

  get numPages(): number | Promise<number> {
    let num: number | Promise<number> = 0;
    if (this.catalog!.hasActualNumPages) {
      num = this.catalog!.numPages!;
    } else if (this.linearization) {
      num = this.linearization.numPages;
    } else {
      num = this.catalog!.numPages!;
    }
    return shadow(this, "numPages", num);
  }

  /**
   * @private
   */
  _hasOnlyDocumentSignatures(fields: (string | Dict | Ref)[], recursionDepth = 0): boolean {
    const RECURSION_LIMIT = 10;

    if (!Array.isArray(fields)) {
      return false;
    }
    return fields.every(field => {
      const value = <Dict | unknown>this.xref.fetchIfRef(<Ref | object>field);
      if (!(value instanceof DictImpl)) {
        return false;
      }
      if (value.has(DictKey.Kids)) {
        if (++recursionDepth > RECURSION_LIMIT) {
          warn("_hasOnlyDocumentSignatures: maximum recursion depth reached");
          return false;
        }
        return this._hasOnlyDocumentSignatures(
          value.getValue(DictKey.Kids),
          recursionDepth
        );
      }
      const isSignature = isName(value.getValue(DictKey.FT), "Sig");
      const rectangle = value.getValue(DictKey.Rect);
      const isInvisible =
        Array.isArray(rectangle) && rectangle.every(value => value === 0);
      return isSignature && isInvisible;
    });
  }

  /**
   * The specification states in section 7.5.2 that the version from
   * the catalog, if present, should overwrite the version from the header.
   */
  get version() {
    return this.catalog!.version || this._version;
  }

  get formInfo() {
    const formInfo = {
      hasFields: false,
      hasAcroForm: false,
      hasSignatures: false,
    };
    const acroForm = this.catalog!.acroForm;
    if (!acroForm) {
      return shadow(this, "formInfo", formInfo);
    }

    try {
      const fields = acroForm.getValue(DictKey.Fields);
      const hasFields = Array.isArray(fields) && fields.length > 0;
      formInfo.hasFields = hasFields; // Used by the `fieldObjects` getter.

      // The document contains AcroForm data if the `Fields` entry is a
      // non-empty array and it doesn't consist of only document signatures.
      // This second check is required for files that don't actually contain
      // AcroForm data (only XFA data), but that use the `Fields` entry to
      // store (invisible) document signatures. This can be detected using
      // the first bit of the `SigFlags` integer (see Table 219 in the
      // specification).
      const sigFlags = acroForm.getValue(DictKey.SigFlags);
      const hasSignatures = !!(sigFlags & 0x1);
      const hasOnlyDocumentSignatures =
        hasSignatures && this._hasOnlyDocumentSignatures(fields);
      formInfo.hasAcroForm = hasFields && !hasOnlyDocumentSignatures;
      formInfo.hasSignatures = hasSignatures;
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      warn(`Cannot fetch form information: "${ex}".`);
    }
    return shadow(this, "formInfo", formInfo);
  }

  get documentInfo(): PDFDocumentInfo {

    const docInfo = new PDFDocumentInfo();
    docInfo.PDFFormatVersion = this.version;
    docInfo.Language = this.catalog!.lang;
    const encrypt = this.xref.encrypt;
    docInfo.EncryptFilterName = encrypt ? encrypt.filterName : null;
    docInfo.IsLinearized = !!this.linearization;
    docInfo.IsAcroFormPresent = this.formInfo.hasAcroForm;
    docInfo.IsCollectionPresent = !!this.catalog!.collection;
    docInfo.IsSignaturesPresent = this.formInfo.hasSignatures;


    let infoDict;
    try {
      infoDict = this.xref.trailer?.getValue(DictKey.Info);
    } catch (err) {
      if (err instanceof MissingDataException) {
        throw err;
      }
      info("The document information dictionary is invalid.");
    }
    if (!(infoDict instanceof DictImpl)) {
      return shadow(this, "documentInfo", docInfo);
    }

    for (const key of infoDict.getKeys()) {
      const value = infoDict.getValue(key);

      switch (key) {
        case DictKey.Title:
        case DictKey.Author:
        case DictKey.Subject:
        case DictKey.Keywords:
        case DictKey.Creator:
        case DictKey.Producer:
        case DictKey.CreationDate:
        case DictKey.ModDate:
          if (typeof value === "string") {
            docInfo[key] = stringToPDFString(value);
            continue;
          }
          break;
        case DictKey.Trapped:
          if (value instanceof Name) {
            docInfo[key] = value;
            continue;
          }
          break;
        default:
          // For custom values, only accept white-listed types to prevent
          // errors that would occur when trying to send non-serializable
          // objects to the main-thread (for example `Dict` or `Stream`).
          let customValue;
          switch (typeof value) {
            case "string":
              customValue = stringToPDFString(value);
              break;
            case "number":
            case "boolean":
              customValue = value;
              break;
            default:
              if (value instanceof Name) {
                customValue = value;
              }
              break;
          }

          if (isNull(customValue)) {
            warn(`Bad value, for custom key "${key}", in Info: ${value}.`);
            continue;
          }
          docInfo.Custom.set(key, customValue);
          continue;
      }
      warn(`Bad value, for key "${key}", in Info: ${value}.`);
    }
    return shadow(this, "documentInfo", docInfo);
  }

  get fingerprints(): [string, string | null] {
    const FINGERPRINT_FIRST_BYTES = 1024;
    const EMPTY_FINGERPRINT = "\x00".repeat(16);

    function validate(data: unknown) {
      return (
        typeof data === "string" &&
        data.length === 16 &&
        data !== EMPTY_FINGERPRINT
      );
    }

    const id = this.xref.trailer!.getValue(DictKey.ID);
    let hashOriginal, hashModified;
    if (Array.isArray(id) && validate(id[0])) {
      hashOriginal = stringToBytes(id[0]);

      if (id[1] !== id[0] && validate(id[1])) {
        hashModified = stringToBytes(id[1]);
      }
    } else {
      hashOriginal = calculateMD5(
        this.stream.getByteRange(0, FINGERPRINT_FIRST_BYTES),
        0,
        FINGERPRINT_FIRST_BYTES
      );
    }

    return shadow(this, "fingerprints", [
      toHexUtil(hashOriginal),
      hashModified ? toHexUtil(hashModified) : null,
    ]);
  }

  async _getLinearizationPage(pageIndex: number) {
    const { linearization, xref } = this;
    const catalog = this.catalog!;
    if (!PlatformHelper.hasDefined() || PlatformHelper.isTesting()) {
      assert(
        linearization?.pageFirst === pageIndex,
        "_getLinearizationPage - invalid pageIndex argument."
      );
    }

    const ref = Ref.get(linearization!.objectNumberFirst, 0);
    try {
      const obj = await xref.fetchAsync(ref);
      // Ensure that the object that was found is actually a Page dictionary.
      if (obj instanceof DictImpl) {
        let type: Name | unknown = obj.getRaw(DictKey.Type);
        if (type instanceof Ref) {
          type = await xref.fetchAsync(type);
        }
        if (
          isName(type, "Page") ||
          (!obj.has(DictKey.Type) && !obj.has(DictKey.Kids) && obj.has(DictKey.Contents))
        ) {
          if (!catalog.pageKidsCountCache.has(ref)) {
            catalog.pageKidsCountCache.put(ref, 1); // Cache the Page reference.
          }
          // Help improve performance of the `Catalog.getPageIndex` method.
          if (!catalog.pageIndexCache.has(ref)) {
            catalog.pageIndexCache.put(ref, 0);
          }

          return [obj, ref];
        }
      }
      throw new FormatError(
        "The Linearization dictionary doesn't point to a valid Page dictionary."
      );
    } catch (reason: unknown) {
      if (reason instanceof BaseException) {
        warn(`_getLinearizationPage: "${reason.message}".`);
      }
      return catalog.getPageDict(pageIndex);
    }
  }

  getPage(pageIndex: number) {
    const cachedPromise = this._pagePromises.get(pageIndex);
    if (cachedPromise) {
      return cachedPromise;
    }
    const { linearization } = this;
    const catalog = this.catalog!;

    let promise: Promise<any>;
    if (linearization?.pageFirst === pageIndex) {
      promise = this._getLinearizationPage(pageIndex);
    } else {
      promise = catalog.getPageDict(pageIndex);
    }
    // 这种promise最好不要复用，因为类型都变了
    const pagePromise = promise.then(([pageDict, ref]: [Dict, Ref | null]) => {
      return new Page(
        this.pdfManager, this.xref, pageIndex, pageDict, ref, this._globalIdFactory, catalog
      );
    });

    this._pagePromises.set(pageIndex, pagePromise);
    return pagePromise;
  }

  async checkFirstPage(recoveryMode = false) {
    if (recoveryMode) {
      return;
    }
    try {
      await this.getPage(0);
    } catch (reason) {
      if (reason instanceof XRefEntryException) {
        // Clear out the various caches to ensure that we haven't stored any
        // inconsistent and/or incorrect state, since that could easily break
        // subsequent `this.getPage` calls.
        this._pagePromises.delete(0);
        await this.cleanup();

        throw new XRefParseException();
      }
    }
  }

  async checkLastPage(recoveryMode = false) {
    const { pdfManager } = this;
    const catalog = this.catalog!;

    catalog.setActualNumPages(); // Ensure that it's always reset.
    let numPages: number = -1;

    try {
      await Promise.all([
        pdfManager.ensureDoc(doc => doc.linearization),
        pdfManager.ensureCatalog(catalog => catalog.numPages),
      ]);

      if (this.linearization) {
        numPages = this.linearization.numPages;
      } else {
        numPages = catalog.numPages!;
      }

      if (!Number.isInteger(numPages)) {
        throw new FormatError("Page count is not an integer.");
      } else if (numPages! <= 1) {
        return;
      }
      await this.getPage(numPages! - 1);
    } catch (reason) {
      // Clear out the various caches to ensure that we haven't stored any
      // inconsistent and/or incorrect state, since that could easily break
      // subsequent `this.getPage` calls.
      this._pagePromises.delete(numPages! - 1);
      await this.cleanup();

      if (reason instanceof XRefEntryException && !recoveryMode) {
        throw new XRefParseException();
      }
      warn(`checkLastPage - invalid /Pages tree /Count: ${numPages}.`);

      let pagesTree;
      try {
        pagesTree = await catalog.getAllPageDicts(recoveryMode);
      } catch (reasonAll) {
        if (reasonAll instanceof XRefEntryException && !recoveryMode) {
          throw new XRefParseException();
        }
        catalog.setActualNumPages(1);
        return;
      }

      for (const [pageIndex, [pageDict, ref]] of pagesTree) {
        let promise;
        if (pageDict instanceof Error) {
          promise = Promise.reject(pageDict);

          // Prevent "uncaught exception: Object"-messages in the console.
          promise.catch(() => { });
        } else {
          promise = Promise.resolve(
            new Page(
              pdfManager, this.xref, pageIndex, pageDict, ref, this._globalIdFactory, catalog
            )
          );
        }

        this._pagePromises.set(pageIndex, promise);
      }
      catalog.setActualNumPages(pagesTree.size);
    }
  }

  fontFallback(id: string, handler: MessageHandler) {
    return this.catalog!.fontFallback(id, handler);
  }

  async cleanup(manuallyTriggered = false): Promise<void> {
    return this.catalog
      ? this.catalog.cleanup(manuallyTriggered)
      : clearGlobalCaches();
  }

  async #collectFieldObjects(
    name: string,
    parentRef: Ref | null,
    fieldRef: string | Ref | Dict,
    promises: Map<string, Promise<FieldObject | null>[]>,
    annotationGlobals: AnnotationGlobals,
    visitedRefs: RefSet,
    orphanFields: RefSetCache<Ref, Ref>
  ) {
    const { xref } = this;

    if (!(fieldRef instanceof Ref) || visitedRefs.has(fieldRef)) {
      return;
    }
    visitedRefs.put(fieldRef);
    const field = await xref.fetchAsync(fieldRef);
    if (!(field instanceof DictImpl)) {
      return;
    }
    if (field.has(DictKey.T)) {
      const partName = stringToPDFString(<string>await field.getAsyncValue(DictKey.T));
      name = name === "" ? partName : `${name}.${partName}`;
    } else {
      let obj: Ref | Dict | unknown = field;
      while (true) {
        obj = (<Dict>obj).getRaw(DictKey.Parent) || parentRef;
        if (obj instanceof Ref) {
          if (visitedRefs.has(obj)) {
            break;
          }
          obj = await xref.fetchAsync(obj);
        }
        if (!(obj instanceof DictImpl)) {
          break;
        }
        if (obj.has(DictKey.T)) {
          const partName = stringToPDFString(<string>await obj.getAsyncValue(DictKey.T));
          name = name === "" ? partName : `${name}.${partName}`;
          break;
        }
      }
    }

    if (
      parentRef &&
      !field.has(DictKey.Parent) &&
      isName(field.getValue(DictKey.Subtype), "Widget")
    ) {
      // We've a parent from the Fields array, but the field hasn't.
      orphanFields.put(fieldRef, parentRef);
    }

    if (!promises.has(name)) {
      promises.set(name, []);
    }
    promises.get(name)!.push(
      AnnotationFactory.create(
        xref, fieldRef, annotationGlobals, null, true, orphanFields, null
      ).then(annotation => annotation?.getFieldObject()).catch(function (reason) {
        warn(`#collectFieldObjects: "${reason}".`);
        return null;
      })
    );

    if (!field.has(DictKey.Kids)) {
      return;
    }
    const kids = await field.getAsyncValue(DictKey.Kids);
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        await this.#collectFieldObjects(
          name, fieldRef, kid, promises, annotationGlobals, visitedRefs, orphanFields
        );
      }
    }
  }

  get fieldObjects() {
    const promise = this.pdfManager.ensureDoc(doc => doc.formInfo).then(async (formInfo) => {
      if (!formInfo.hasFields) {
        return null;
      }

      const [annotationGlobals, acroForm] = await Promise.all([
        this.pdfManager.ensureDoc(doc => doc.annotationGlobals),
        this.pdfManager.ensureCatalog(catalog => catalog.acroForm),
      ]);
      if (!annotationGlobals) {
        return null;
      }

      const visitedRefs = new RefSet();
      const allFields = new Map<string, FieldObject[]>();
      const fieldPromises = new Map<string, Promise<FieldObject | null>[]>();
      const orphanFields = new RefSetCache<Ref, Ref>();
      for (const fieldRef of await acroForm!.getAsyncValue(DictKey.Fields)) {
        await this.#collectFieldObjects(
          "", null, fieldRef, fieldPromises, annotationGlobals, visitedRefs, orphanFields
        );
      }

      const allPromises = [];
      for (const [name, promises] of fieldPromises) {
        allPromises.push(
          Promise.all(promises).then(fields => {
            fields = fields.filter(field => !!field);
            if (fields.length > 0) {
              allFields.set(name, <FieldObject[]>fields);
            }
          })
        );
      }

      await Promise.all(allPromises);
      return { allFields, orphanFields };
    });

    return shadow(this, "fieldObjects", promise);
  }

  get hasJSActions() {
    const promise = this.pdfManager.ensureDoc(doc => doc._parseHasJSActions());
    return shadow(this, "hasJSActions", promise);
  }

  /**
   * @private
   */
  async _parseHasJSActions() {
    const [catalogJsActions, fieldObjects] = await Promise.all([
      this.pdfManager.ensureCatalog(catalog => catalog.jsActions),
      this.pdfManager.ensureDoc(doc => doc.fieldObjects),
    ]);

    if (catalogJsActions) {
      return true;
    }
    if (fieldObjects) {
      return fieldObjects.allFields.values().some(fieldObject =>
        fieldObject.some((object: FieldObject) => (<{ actions?: unknown }>object).actions !== null)
      );
    }
    return false;
  }

  get calculationOrderIds() {
    const calculationOrder = this.catalog!.acroForm?.getValue(DictKey.CO);
    if (!Array.isArray(calculationOrder) || calculationOrder.length === 0) {
      return shadow(this, "calculationOrderIds", null);
    }

    const ids = <string[]>[];
    for (const id of calculationOrder) {
      if (id instanceof Ref) {
        ids.push(id.toString());
      }
    }
    return shadow(this, "calculationOrderIds", ids.length ? ids : null);
  }

  get annotationGlobals() {
    return shadow(this, "annotationGlobals", AnnotationFactory.createGlobals(this.pdfManager));
  }
}
