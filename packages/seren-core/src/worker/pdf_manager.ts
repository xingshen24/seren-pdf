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
  MessageHandler,
  DocumentEvaluatorOptions,
  AbortException,
  createValidAbsoluteUrl,
  FeatureTest,
  warn
} from "seren-common";
import { Catalog } from "../document/catalog";
import { ChunkedStreamManager } from "../stream/chunked_stream";
import { MissingDataException } from "../utils/core_utils";
import { Page, PDFDocument } from "../document/document";
import { Stream } from "../stream/stream";
import { PDFWorkerStream } from "../stream/worker_stream";
import { XRefImpl } from "../document/xref";

function parseDocBaseUrl(url: string | null) {
  if (url) {
    const absoluteUrl = createValidAbsoluteUrl(url);
    if (absoluteUrl) {
      return absoluteUrl.href;
    }
    warn(`Invalid absolute docBaseUrl: "${url}".`);
  }
  return null;
}

export interface PDFManagerArgs {
  source: PDFWorkerStream | Uint8Array<ArrayBuffer> | null;
  disableAutoFetch: boolean;
  docBaseUrl: string | null;
  docId: string;
  evaluatorOptions: DocumentEvaluatorOptions;
  handler: MessageHandler;
  length: number;
  password: string | null;
  rangeChunkSize: number;
}

export interface PDFManager {

  docId: string;

  password: string | null;

  evaluatorOptions: DocumentEvaluatorOptions;

  docBaseUrl: string;

  catalog: Catalog;

  getPage(pageIndex: number): Promise<Page>;

  updatePassword(password: string): void;

  ensure<T, R>(obj: T, fn: (obj: T) => R | Promise<R>): Promise<R>;

  ensureDoc<T>(fn: (doc: PDFDocument) => T | Promise<T>): Promise<T>;

  ensureXRef<T>(fn: (xref: XRefImpl) => T): Promise<T>;

  ensureCatalog<T>(fn: (catalog: Catalog) => T | Promise<T>): Promise<T>;

  requestRange(_begin: number, _end: number): Promise<unknown>;

  requestLoadedStream(noFetch: boolean): Promise<Stream>;

  sendProgressiveData(chunk: ArrayBufferLike): void;

  terminate(ex: AbortException): void;

  cleanup(manuallyTriggered?: boolean): Promise<void>;

  getPDFDocument(): PDFDocument;

  fontFallback(id: string, handler: MessageHandler): Promise<void>;

}

export class PDFDocumentEnsurer {

  protected pdfManager: PDFManager;

  constructor(pdfManager: PDFManager) {
    this.pdfManager = pdfManager;
  }

}

abstract class BasePDFManager implements PDFManager {

  readonly _docId: string;

  protected _docBaseUrl: string | null;

  protected _password: string | null;

  readonly evaluatorOptions: DocumentEvaluatorOptions;

  constructor(args: PDFManagerArgs) {

    this._docBaseUrl = parseDocBaseUrl(args.docBaseUrl);
    this._docId = args.docId;
    this._password = args.password;

    // Check `OffscreenCanvas` support once, rather than repeatedly throughout
    // the worker-thread code.
    args.evaluatorOptions.isOffscreenCanvasSupported &&=
      FeatureTest.isOffscreenCanvasSupported;
    this.evaluatorOptions = Object.freeze(args.evaluatorOptions);
  }

  get docId() {
    return this._docId;
  }

  get password() {
    return this._password;
  }

  updatePassword(password: string) {
    this._password = password;
  };

  get docBaseUrl() {
    return this._docBaseUrl!;
  }

  get catalog() {
    return this.getPDFDocument().catalog!;
  }


  ensureDoc<T>(fn: (doc: PDFDocument) => T | Promise<T>): Promise<T> {
    return this.ensure(this.getPDFDocument(), fn);
  }

  ensureXRef<T>(fn: (xref: XRefImpl) => T) {
    return this.ensure(this.getPDFDocument().xref, fn);
  }

  ensureCatalog<T>(fn: (catalog: Catalog) => T | Promise<T>) {
    return this.ensure(this.getPDFDocument().catalog!, fn);
  }

  getPage(pageIndex: number) {
    return this.getPDFDocument().getPage(pageIndex);
  }

  fontFallback(id: string, handler: MessageHandler) {
    return this.getPDFDocument().fontFallback(id, handler);
  }

  cleanup(manuallyTriggered = false): Promise<void> {
    return this.getPDFDocument().cleanup(manuallyTriggered);
  }

  abstract ensure<T, R>(obj: T, fn: (obj: T) => R | Promise<R>): Promise<R>;

  abstract requestRange(begin: number, end: number): Promise<void>;

  abstract requestLoadedStream(noFetch?: boolean): Promise<Stream>;

  abstract sendProgressiveData(chunk: ArrayBufferLike): void;

  abstract terminate(reason: AbortException): void;

  abstract getPDFDocument(): PDFDocument;

}

export class LocalPDFManager extends BasePDFManager {

  public pdfDocument: PDFDocument;

  protected _loadedStreamPromise: Promise<Stream>;

  constructor(args: PDFManagerArgs) {
    super(args);

    const stream = new Stream(<Uint8Array<ArrayBuffer>>args.source);
    this.pdfDocument = new PDFDocument(this, stream);
    this._loadedStreamPromise = Promise.resolve(stream);
  }

  async ensure<T, R>(obj: T, fn: (obj: T) => R | Promise<R>) {
    const result = fn(obj);
    return result;
  }

  requestRange(_begin: number, _end: number) {
    return Promise.resolve();
  }

  requestLoadedStream(_noFetch = false) {
    return this._loadedStreamPromise;
  }

  sendProgressiveData(_chunk: ArrayBufferLike) {
    throw new Error("Method not implemented.");
  }

  terminate(_ex: AbortException) { }

  getPDFDocument(): PDFDocument {
    return this.pdfDocument;
  }
}

export class NetworkPDFManager extends BasePDFManager {

  public pdfDocument: PDFDocument;

  public streamManager: ChunkedStreamManager;

  constructor(args: PDFManagerArgs) {
    super(args);

    this.streamManager = new ChunkedStreamManager(
      <PDFWorkerStream>args.source!,
      args.handler,
      args.length,
      args.disableAutoFetch,
      args.rangeChunkSize,
    );
    this.pdfDocument = new PDFDocument(this, this.streamManager.getStream());
  }

  async ensure<T, R>(obj: T, fn: (obj: T) => R | Promise<R>): Promise<R> {
    try {
      let value = await fn(obj);
      if (value instanceof Promise) {
        value = await value;
      }
      return value;
    } catch (ex) {
      if (!(ex instanceof MissingDataException)) {
        throw ex;
      }
      await this.requestRange(ex.begin, ex.end);
      return this.ensure(obj, fn);
    }
  }

  requestRange(begin: number, end: number) {
    return this.streamManager.requestRange(begin, end);
  }

  requestLoadedStream(noFetch = false): Promise<Stream> {
    return <Promise<Stream>>this.streamManager.requestAllChunks(noFetch);
  }

  sendProgressiveData(chunk: ArrayBuffer) {
    this.streamManager.onReceiveData(chunk);
  }

  terminate(reason: AbortException) {
    this.streamManager.abort(reason);
  }

  getPDFDocument(): PDFDocument {
    return this.pdfDocument;
  }
}
