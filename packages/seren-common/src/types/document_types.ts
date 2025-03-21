import { DestinationType, RectType } from "../common/common_types";
import { Name } from "../document/primitives";
import { DocumentEvaluatorOptions } from "./document_evaluator_options";
import { FileSpecSerializable } from "./message_handler_types";

export class DocumentParameter {

  readonly docId: string;

  readonly apiVersion: string | null;

  readonly data: Uint8Array<ArrayBuffer> | null;

  readonly password: string | null;

  readonly disableAutoFetch: boolean;

  readonly rangeChunkSize: number;

  readonly length: number;

  readonly docBaseUrl: string | null;

  readonly evaluatorOptions: DocumentEvaluatorOptions;

  constructor(
    docId: string,
    apiVersion: string | null,
    data: Uint8Array<ArrayBuffer> | null,
    password: string | null,
    disableAutoFetch: boolean,
    rangeChunkSize: number,
    length: number,
    docBaseUrl: string | null,
    evaluatorOptions: DocumentEvaluatorOptions
  ) {
    this.docId = docId;
    this.apiVersion = apiVersion;
    this.data = data;
    this.password = password;
    this.disableAutoFetch = disableAutoFetch;
    this.rangeChunkSize = rangeChunkSize;
    this.length = length;
    this.docBaseUrl = docBaseUrl;
    this.evaluatorOptions = evaluatorOptions;
  }
}
export class StructTreeSerialNode {

  public role: string;

  public children: (StructTreeSerialNode | StructTreeSerialLeaf)[] = [];

  public alt: string | null = null;

  public bbox: RectType | null = null;

  public lang: string | null = null;

  constructor(role: string) {
    this.role = role;
  }
}

export interface StructTreeSerialLeaf {
  type: string;
  id: string;
}

export class PDFDocumentInfo {
  PDFFormatVersion: string | null = null;
  Language: string | null = null;
  EncryptFilterName: string | null = null;
  IsLinearized: boolean = false;
  IsAcroFormPresent: boolean = false;
  IsCollectionPresent: boolean = false;
  IsSignaturesPresent: boolean = false;
  Title: string | null = null;
  Author: string | null = null;
  Subject: string | null = null;
  Keywords: string | null = null;
  Creator: string | null = null;
  Producer: string | null = null;
  CreationDate: string | null = null;
  ModDate: string | null = null;
  Trapped: Name | null = null;
  Custom: Map<string, string | number | boolean | Name> = new Map();
}

export interface PDFMetadataInfo {
  parsedData: Map<string, string | string[]>;
  rawData: string;
}

/**
 * Properties correspond to Table 321 of the PDF 32000-1:2008 spec.
 */
export class CatalogMarkInfo {
  Marked = false;
  UserProperties = false;
  Suspects = false;
}

export interface CatalogOutlineItem {
  action: string | null;
  attachment: FileSpecSerializable | null;
  dest: string | DestinationType | null;
  url: string | null;
  unsafeUrl: string | null;
  newWindow: boolean | null;
  setOCGState: {
    state: string[];
    preserveRB: boolean;
  } | null;
  title: string;
  color: Uint8ClampedArray<ArrayBuffer>;
  count: number | null;
  bold: boolean;
  italic: boolean;
  items: CatalogOutlineItem[];
}

