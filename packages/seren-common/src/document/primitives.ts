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

import { PlatformHelper } from "../utils/platform_helper";
import { DestinationType, PointType, RectType, TypedArray } from "../common/common_types";
import { assert, unreachable, isNull } from '../utils/util';
import { Dict } from "./dict";
import { DataStream } from "../types/stream_types";

export const CIRCULAR_REF = Symbol("CIRCULAR_REF");

export const EOF = Symbol("EOF");

const CmdCache = new Map<string, Cmd>();

const NameCache = new Map<string, Name>();

const RefCache = new Map<string, Ref>();

export function clearPrimitiveCaches() {
  CmdCache.clear()
  NameCache.clear();
  RefCache.clear();
}

export class Name {

  public name: string;

  constructor(name: string) {
    assert(typeof name === 'string', 'Name: The "name" must be a string.');
    this.name = name;
  }

  static get(name: string): Name {
    // eslint-disable-next-line no-restricted-syntax
    const cache = NameCache.get(name);
    if (!cache) {
      NameCache.set(name, new Name(name))
    }
    return NameCache.get(name)!;
  }
}

export class Cmd {

  readonly cmd: string;

  constructor(cmd: string) {
    if ((!PlatformHelper.hasDefined() || PlatformHelper.isTesting()) && typeof cmd !== "string") {
      unreachable('Cmd: The "cmd" must be a string.');
    }
    this.cmd = cmd;
  }

  static get(cmd: string) {
    // eslint-disable-next-line no-restricted-syntax
    const cache = CmdCache.get(cmd);
    if (!cache) {
      CmdCache.set(this.name, new Cmd(cmd))
    }
    return CmdCache.get(this.name) ?? null;
  }
}

const nonSerializable = function nonSerializableClosure() {
  return nonSerializable; // Creating closure on some variable.
};

// 为了防止Dict在get和set之后类型丢失，导致不知道无法获取到类型信息
// 因此将所有的dict类型都拿出来
export enum DictKey {
  Parent = "Parent",
  Subtype = "Subtype",
  Fm0 = "Fm0",
  GS0 = "GS0",
  Resources = "Resources",
  BBox = "BBox",
  R = "R",
  BC = "BC",
  BG = "BG",
  V = "V",
  MK = "MK",
  M = "M",
  Matrix = "Matrix",
  FormType = "FormType",
  Length = "Length",
  PdfJsZaDb = "PdfJsZaDb",
  Font = "Font",
  BaseFont = "BaseFont",
  Encoding = "Encoding",
  I = "I",
  N = "N",
  Helv = "Helv",
  CreationDate = "CreationDate",
  Rect = "Rect",
  InkList = "InkList",
  F = "F",
  Rotate = "Rotate",
  IT = "IT",
  BS = "BS",
  C = "C",
  CA = "CA",
  AP = "AP",
  R0 = "R0",
  ExtGState = "ExtGState",
  BM = "BM",
  ca = "ca",
  Type = "Type",
  BitsPerComponent = "BitsPerComponent",
  ColorSpace = "ColorSpace",
  Width = "Width",
  Height = "Height",
  XObject = "XObject",
  Im0 = "Im0",
  A = "A",
  FontName = "FontName",
  FontFamily = "FontFamily",
  FontBBox = "FontBBox",
  FontStretch = "FontStretch",
  FontWeight = "FontWeight",
  ItalicAngle = "ItalicAngle",
  CIDToGIDMap = "CIDToGIDMap",
  FirstChar = "FirstChar",
  LastChar = "LastChar",
  FontDescriptor = "FontDescriptor",
  DW = "DW",
  W = "W",
  Ordering = "Ordering",
  Registry = "Registry",
  Supplement = "Supplement",
  CIDSystemInfo = "CIDSystemInfo",
  DescendantFonts = "DescendantFonts",
  ToUnicode = "ToUnicode",
  Annots = "Annots",
  K = "K",
  Nums = "Nums",
  ParentTreeNextKey = "ParentTreeNextKey",
  ParentTree = "ParentTree",
  Pg = "Pg",
  Obj = "Obj",
  Filter = "Filter",
  DecodeParms = "DecodeParms",
  NeedAppearances = "NeedAppearances",
  Index = "Index",
  ID = "ID",
  Prev = "Prev",
  Size = "Size",
  Root = "Root",
  Info = "Info",
  Encrypt = "Encrypt",

  // 以下只有get没有set，可能是动态引入的
  T = "T",
  Contents = "Contents",
  StructParent = "StructParent",
  Kids = "Kids",
  DA = "DA",
  S = "S",
  D = "D",
  AS = "AS",
  OC = "OC",
  TU = "TU",
  DR = "DR",
  Off = "Off",
  Name = "Name",
  StateModel = "StateModel",
  State = "State",
  Open = "Open",
  IC = "IC",
  FS = "FS",
  Version = "Version",
  Lang = "Lang",
  NeedsRendering = "NeedsRendering",
  Collection = "Collection",
  AcroForm = "AcroForm",
  MarkInfo = "MarkInfo",
  Pages = "Pages",
  Outlines = "Outlines",
  P = "P",
  OCProperties = "OCProperties",
  Print = "Print",
  PrintState = "PrintState",
  View = "View",
  ViewState = "ViewState",
  Count = "Count",
  St = "St",
  PageLayout = "PageLayout",
  PageMode = "PageMode",
  ViewerPreferences = "ViewerPreferences",
  OpenAction = "OpenAction",
  Names = "Names",
  EmbeddedFiles = "EmbeddedFiles",

  JS = "JS",
  Base = "Base",
  Dest = "Dest",
  AA = "AA",
  U = "U",
  Flags = "Flags",
  Fields = "Fields",
  URI = "URI",
  NewWindow = "NewWindow",
  PreserveRB = "PreserveRB",
  CF = "CF",
  StmF = "StmF",
  O = "O",
  EncryptMetadata = "EncryptMetadata",
  OE = "OE",
  UE = "UE",
  Perms = "Perms",
  EFF = "EFF",
  StrF = "StrF",
  UserUnit = "UserUnit",
  FT = "FT",
  SigFlags = "SigFlags",
  CO = "CO",
  Group = "Group",
  H = "H",
  ImageMask = "ImageMask",
  IM = "IM",
  Interpolate = "Interpolate",
  G = "G",
  TR = "TR",
  Pattern = "Pattern",
  Shading = "Shading",
  MCID = "MCID",
  BaseEncoding = "BaseEncoding",
  Differences = "Differences",
  DOS = "DOS",
  Mac = "Mac",
  Unix = "Unix",
  UF = "UF",
  RF = "RF",
  EF = "EF",
  Desc = "Desc",
  JBIG2Globals = "JBIG2Globals",
  BPC = "BPC",
  DP = "DP",
  Linearized = "Linearized",
  ShadingType = "ShadingType",
  CS = "CS",
  Background = "Background",
  Function = "Function",
  BitsPerCoordinate = "BitsPerCoordinate",
  BitsPerFlag = "BitsPerFlag",
  Decode = "Decode",
  VerticesPerRow = "VerticesPerRow",
  Predictor = "Predictor",
  Colors = "Colors",
  Columns = "Columns",
  RoleMap = "RoleMap",
  XRefStm = "XRefStm",
  First = "First",
  QuadPoints = "QuadPoints",
  Border = "Border",
  L = "L",
  LE = "LE",
  Vertices = "Vertices",
  PMD = "PMD",
  Dests = "Dests",
  JavaScript = "JavaScript",
  SMask = "SMask",
  Mask = "Mask",
  FunctionType = "FunctionType",
  Metadata = "Metadata",
  StructTreeRoot = "StructTreeRoot",
  PageLabels = "PageLabels",
  Next = "Next",
  LW = "LW",
  LC = "LC",
  LJ = "LJ",
  ML = "ML",
  RI = "RI",
  FL = "FL",
  OP = "OP",
  op = "op",
  OPM = "OPM",
  BG2 = "BG2",
  UCR = "UCR",
  UCR2 = "UCR2",
  TR2 = "TR2",
  HT = "HT",
  SM = "SM",
  SA = "SA",
  AIS = "AIS",
  TK = "TK",
  PatternType = "PatternType",
  Properties = "Properties",
  VE = "VE",
  OCGs = "OCGs",
  Trapped = "Trapped",
  ModDate = "ModDate",
  Producer = "Producer",
  Creator = "Creator",
  Keywords = "Keywords",
  Subject = "Subject",
  Author = "Author",
  Title = "Title",
  RT = "RT",
  IRT = "IRT",
  Popup = "Popup",
  RC = "RC",
  Marked = "Marked",
  UserProperties = "UserProperties",
  Suspects = "Suspects",
  Intent = "Intent",
  Usage = "Usage",
  BaseState = "BaseState",
  RBGroups = "RBGroups",
  ON = "ON",
  OFF = "OFF",
  Order = "Order",
  Limits = "Limits",
  HideToolbar = "HideToolbar",
  HideMenubar = "HideMenubar",
  HideWindowUI = "HideWindowUI",
  FitWindow = "FitWindow",
  CenterWindow = "CenterWindow",
  DisplayDocTitle = "DisplayDocTitle",
  PickTrayByPDFSize = "PickTrayByPDFSize",
  NonFullScreenPageMode = "NonFullScreenPageMode",
  Direction = "Direction",
  ViewArea = "ViewArea",
  ViewClip = "ViewClip",
  PrintArea = "PrintArea",
  PrintClip = "PrintClip",
  PrintScaling = "PrintScaling",
  Duplex = "Duplex",
  PrintPageRange = "PrintPageRange",
  NumCopies = "NumCopies",
  BitsPerSample = "BitsPerSample",
  Encode = "Encode",
  Domain = "Domain",
  Range = "Range",
  C0 = "C0",
  C1 = "C1",
  Functions = "Functions",
  Bounds = "Bounds",
  Coords = "Coords",
  Extend = "Extend",
  XStep = "XStep",
  YStep = "YStep",
  PaintType = "PaintType",
  TilingType = "TilingType",
  Widths = "Widths",
  CapHeight = "CapHeight",
  XHeight = "XHeight",
  Ascent = "Ascent",
  Descent = "Descent",
  FontMatrix = "FontMatrix",
  DW2 = "DW2",
  W2 = "W2",
  MissingWidth = "MissingWidth",
  FontFile = "FontFile",
  FontFile2 = "FontFile2",
  FontFile3 = "FontFile3",
  Length1 = "Length1",
  Length2 = "Length2",
  Length3 = "Length3",
  CharProcs = "CharProcs",
  EndOfLine = "EndOfLine",
  EncodedByteAlign = "EncodedByteAlign",
  Rows = "Rows",
  EndOfBlock = "EndOfBlock",
  BlackIs1 = "BlackIs1",
  StructParents = "StructParents",
  SMaskInData = "SMaskInData",
  Matte = "Matte",
  Alt = "Alt",
  E = "E",
  ActualText = "ActualText",
  WhitePoint = "WhitePoint",
  BlackPoint = "BlackPoint",
  Gamma = "Gamma",
  EarlyChange = "EarlyChange",
  ColorTransform = "ColorTransform",
  Alternate = "Alternate",
  MediaBox = "MediaBox",
  CropBox = "CropBox",
  Q = "Q",
  MaxLen = "MaxLen",
  Stm = "Stm",
  CFM = "CFM",
  DV = "DV",
  Ff = "Ff",
  Opt = "Opt",
}

/**
 * 为了实现一下
 */
export type DictValueTypeMapping = {
  [DictKey.AA]: Dict,
  [DictKey.AP]: Dict,
  [DictKey.AS]: Name,
  [DictKey.A]: Dict,
  [DictKey.AcroForm]: Dict,
  [DictKey.Annots]: Ref[], // 也可能是(Ref | ???)[]
  [DictKey.BBox]: RectType,
  [DictKey.BC]: number[],
  [DictKey.BG]: number[],
  [DictKey.BM]: Name | Name[],
  [DictKey.BPC]: number,
  [DictKey.BS]: Dict,
  [DictKey.Background]: TypedArray,
  [DictKey.BaseEncoding]: Name,
  [DictKey.BaseFont]: Name | undefined,
  [DictKey.Base]: string,
  [DictKey.BitsPerComponent]: number,
  [DictKey.BitsPerCoordinate]: number,
  [DictKey.BitsPerFlag]: number,
  [DictKey.Border]: (number | number[] | Ref)[],
  [DictKey.ca]: number,
  [DictKey.CA]: number,
  [DictKey.CF]: Dict,
  [DictKey.CIDSystemInfo]: Dict,
  [DictKey.CIDToGIDMap]: Name | Ref | DataStream,
  [DictKey.CO]: (string | Ref)[],
  [DictKey.CS]: Name,
  [DictKey.C]: number[],
  [DictKey.Collection]: Dict,
  [DictKey.ColorSpace]: Name,
  [DictKey.Colors]: number,
  [DictKey.Columns]: number,
  [DictKey.Contents]: string,
  [DictKey.Count]: number | Ref,
  [DictKey.CreationDate]: string,
  [DictKey.DA]: string,
  [DictKey.DOS]: string | Ref,
  [DictKey.DP]: Dict,
  [DictKey.DR]: Dict,
  [DictKey.DW]: number,
  [DictKey.D]: number[] | Dict | Name | DestinationType,
  [DictKey.DecodeParms]: Dict | (Dict | null)[],
  [DictKey.Decode]: number[],
  [DictKey.Desc]: string,
  [DictKey.DescendantFonts]: Ref[],
  [DictKey.Dest]: "Dest",
  [DictKey.Dests]: Dict | Ref,
  [DictKey.Differences]: (number | Name | Ref)[],
  [DictKey.EFF]: Name,
  [DictKey.EF]: Dict,
  [DictKey.EmbeddedFiles]: Ref,
  [DictKey.Encoding]: Name | Ref | Dict | undefined,
  [DictKey.EncryptMetadata]: boolean,
  [DictKey.Encrypt]: Ref,
  [DictKey.ExtGState]: Dict,
  [DictKey.FS]: string | Dict,
  [DictKey.FT]: Name | string,
  [DictKey.F]: number | Dict,
  [DictKey.Fields]: (string | Ref | Dict)[],
  [DictKey.Filter]: Name | Name[],
  [DictKey.FirstChar]: number,
  [DictKey.First]: Ref | number, // 实际上应该是Ref<number>，但是Ref没有类型，应该加上类型
  [DictKey.Flags]: number,
  [DictKey.Fm0]: DataStream, // 实际上应该是一个StringStream
  [DictKey.FontBBox]: RectType,
  [DictKey.FontDescriptor]: Ref | Dict,
  [DictKey.FontFamily]: string,
  [DictKey.FontName]: Name,
  [DictKey.FontStretch]: Name,
  [DictKey.FontWeight]: number,
  [DictKey.Font]: Dict | [Ref, number],
  [DictKey.FormType]: number,
  [DictKey.FunctionType]: number,
  [DictKey.Function]: Ref | Dict | DataStream | (Ref | Dict | DataStream)[],
  [DictKey.GS0]: Dict,
  [DictKey.G]: DataStream,
  [DictKey.Group]: Dict,
  [DictKey.H]: number,
  [DictKey.Height]: number,
  [DictKey.Helv]: Dict | Ref,
  [DictKey.IC]: TypedArray,
  [DictKey.ID]: [string, string],
  [DictKey.IM]: boolean,
  [DictKey.IT]: Name,
  [DictKey.I]: number[],
  [DictKey.Im0]: Ref,
  [DictKey.ImageMask]: boolean,
  [DictKey.Index]: number[],
  [DictKey.Info]: Ref,
  [DictKey.InkList]: (number | Ref)[][],
  [DictKey.Interpolate]: number[], // 应该和I保持一致
  [DictKey.ItalicAngle]: number,
  [DictKey.JBIG2Globals]: DataStream,
  [DictKey.JS]: DataStream | string,
  [DictKey.JavaScript]: string,
  [DictKey.K]: Dict | number | Ref | Ref[],
  [DictKey.Kids]: (string | Dict | Ref)[], // 某种类型的数组，具体还要仔细分析
  [DictKey.LE]: Name[],
  [DictKey.L]: RectType,
  [DictKey.Lang]: string,
  [DictKey.LastChar]: number,
  [DictKey.Length]: number,
  [DictKey.Linearized]: number,
  [DictKey.MCID]: number,
  [DictKey.MK]: Dict,
  [DictKey.M]: string,
  [DictKey.Mac]: string | Ref,
  [DictKey.MarkInfo]: Dict,
  [DictKey.Mask]: DataStream | number[], // DataStream或某种类型的数组，猜测是数字数组
  [DictKey.Matrix]: number[],
  [DictKey.Metadata]: Ref,
  [DictKey.N]: Ref | DataStream | number | null, // 实际上应该是个StringStream
  [DictKey.Name]: Name | string,
  [DictKey.Names]: Dict,
  [DictKey.NeedAppearances]: boolean,
  [DictKey.NeedsRendering]: boolean,
  [DictKey.NewWindow]: boolean,
  [DictKey.Next]: Ref,
  [DictKey.Nums]: (Ref | number)[], // 某种类型的数组，具体还要仔细分析
  [DictKey.OCProperties]: Dict,
  [DictKey.OC]: Name | Dict,
  [DictKey.OE]: string,
  [DictKey.O]: string,
  [DictKey.Obj]: Ref,
  [DictKey.Off]: DataStream,
  [DictKey.OpenAction]: Dict | DestinationType,
  [DictKey.Open]: "Open",
  [DictKey.Ordering]: string,
  [DictKey.Outlines]: Dict,
  [DictKey.PMD]: unknown, // 这个值只有一处读取，没有具体的写入，给个unknown吧
  [DictKey.P]: string | number | Ref | Dict | Name,
  [DictKey.PageLabels]: Dict | Ref,
  [DictKey.PageLayout]: Name,
  [DictKey.PageMode]: Name,
  [DictKey.Pages]: Ref | Dict, // Dict或者Ref
  [DictKey.ParentTreeNextKey]: number,
  [DictKey.ParentTree]: Ref,
  [DictKey.Parent]: Ref | Dict,
  [DictKey.Pattern]: Dict,
  [DictKey.PdfJsZaDb]: Dict,
  [DictKey.Perms]: string,
  [DictKey.Pg]: Ref,
  [DictKey.Predictor]: number,
  [DictKey.PreserveRB]: boolean,
  [DictKey.Prev]: number | Ref,
  [DictKey.PrintState]: Name,
  [DictKey.Print]: Dict,
  [DictKey.QuadPoints]: number[],
  [DictKey.R0]: Dict,
  [DictKey.RF]: unknown, // 该功能尚未开发，因此使用unknown来作为标记
  [DictKey.R]: number,
  [DictKey.Rect]: RectType,
  [DictKey.Registry]: string,
  [DictKey.Resources]: Dict,
  [DictKey.RoleMap]: Dict,
  [DictKey.Root]: Ref,
  [DictKey.Rotate]: number,
  [DictKey.SMask]: Ref | DataStream,
  [DictKey.S]: Name,
  [DictKey.ShadingType]: number,
  [DictKey.Shading]: Dict,
  [DictKey.SigFlags]: number,
  [DictKey.Size]: number | number[],
  [DictKey.St]: number,
  [DictKey.StateModel]: string, // 只有一个值，是在测试环境中发现的
  [DictKey.State]: (Name | Ref)[],
  [DictKey.StmF]: Name,
  [DictKey.StrF]: Name,
  [DictKey.StructParent]: number,
  [DictKey.StructTreeRoot]: Name | Ref,
  [DictKey.Subtype]: Name | undefined,
  [DictKey.Supplement]: number,
  [DictKey.TR]: Dict | DataStream,
  [DictKey.TU]: string,
  [DictKey.T]: string | Dict,
  [DictKey.ToUnicode]: Name,
  [DictKey.Type]: Name | undefined,
  [DictKey.UE]: string,
  [DictKey.UF]: string | Ref,
  [DictKey.URI]: Dict,
  [DictKey.U]: string,
  [DictKey.Unix]: string | Ref,
  [DictKey.UserUnit]: number,
  [DictKey.V]: number | string | string[] | Name,
  [DictKey.Version]: Name,
  [DictKey.VerticesPerRow]: number,
  [DictKey.Vertices]: number[],
  [DictKey.ViewState]: Name,
  [DictKey.View]: Dict,
  [DictKey.ViewerPreferences]: Dict,
  [DictKey.W]: number | number[] | number[][] | Ref[] | Ref[][], // number是推测的
  [DictKey.Width]: number,
  [DictKey.XObject]: Dict,
  [DictKey.XRefStm]: number,
  [DictKey.LW]: "LW",
  [DictKey.LC]: "LC",
  [DictKey.LJ]: "LJ",
  [DictKey.ML]: "ML",
  [DictKey.RI]: "RI",
  [DictKey.FL]: "FL",
  [DictKey.OP]: "OP",
  [DictKey.op]: "op",
  [DictKey.OPM]: "OPM",
  [DictKey.BG2]: "BG2",
  [DictKey.UCR]: "UCR",
  [DictKey.UCR2]: "UCR2",
  [DictKey.TR2]: "TR2",
  [DictKey.HT]: "HT",
  [DictKey.SM]: "SM",
  [DictKey.SA]: "SA",
  [DictKey.AIS]: "AIS",
  [DictKey.TK]: "TK",
  [DictKey.PatternType]: number,
  [DictKey.Properties]: Dict,
  [DictKey.VE]: any[],
  [DictKey.OCGs]: Dict | object[],
  [DictKey.Trapped]: "Trapped",
  [DictKey.ModDate]: "ModDate",
  [DictKey.Producer]: "Producer",
  [DictKey.Creator]: "Creator",
  [DictKey.Keywords]: "Keywords",
  [DictKey.Subject]: "Subject",
  [DictKey.Author]: "Author",
  [DictKey.Title]: "Title",
  [DictKey.RT]: Name,
  [DictKey.IRT]: Ref | Dict,
  [DictKey.Popup]: Ref,
  [DictKey.RC]: string,
  [DictKey.Marked]: boolean,
  [DictKey.UserProperties]: boolean,
  [DictKey.Suspects]: boolean,
  [DictKey.Intent]: Name | Name[],
  [DictKey.Usage]: Dict,
  [DictKey.BaseState]: Name,
  [DictKey.RBGroups]: Ref[][],
  [DictKey.ON]: Ref[],
  [DictKey.OFF]: Ref[],
  [DictKey.Order]: Ref[] | number,
  [DictKey.Limits]: "Limits",
  [DictKey.HideToolbar]: boolean,
  [DictKey.HideMenubar]: boolean,
  [DictKey.HideWindowUI]: boolean,
  [DictKey.FitWindow]: boolean,
  [DictKey.CenterWindow]: boolean,
  [DictKey.DisplayDocTitle]: boolean,
  [DictKey.PickTrayByPDFSize]: boolean,
  [DictKey.NonFullScreenPageMode]: Name,
  [DictKey.Direction]: Name,
  [DictKey.ViewArea]: Name,
  [DictKey.ViewClip]: Name,
  [DictKey.PrintArea]: Name,
  [DictKey.PrintClip]: Name,
  [DictKey.PrintScaling]: Name,
  [DictKey.Duplex]: Name,
  [DictKey.PrintPageRange]: [number, number],
  [DictKey.NumCopies]: number,
  [DictKey.BitsPerSample]: number,
  [DictKey.Encode]: number[]
  [DictKey.Domain]: number[],
  [DictKey.Range]: number[],
  [DictKey.C0]: number[],
  [DictKey.C1]: number[],
  [DictKey.Functions]: "Functions",
  [DictKey.Bounds]: number[],
  [DictKey.Coords]: number[]
  [DictKey.Extend]: [boolean, boolean],
  [DictKey.XStep]: number,
  [DictKey.YStep]: number,
  [DictKey.PaintType]: number,
  [DictKey.TilingType]: number,
  [DictKey.Widths]: number[] | Ref[],
  [DictKey.CapHeight]: number,
  [DictKey.XHeight]: number,
  [DictKey.Ascent]: number,
  [DictKey.Descent]: number,
  [DictKey.FontMatrix]: number[],
  [DictKey.DW2]: PointType,
  [DictKey.W2]: (Ref | number)[],
  [DictKey.MissingWidth]: number,
  [DictKey.FontFile]: DataStream,
  [DictKey.FontFile2]: DataStream,
  [DictKey.FontFile3]: DataStream,
  [DictKey.Length1]: number,
  [DictKey.Length2]: number,
  [DictKey.Length3]: number,
  [DictKey.CharProcs]: Dict,
  [DictKey.EndOfLine]: boolean,
  [DictKey.EncodedByteAlign]: boolean,
  [DictKey.Rows]: number,
  [DictKey.EndOfBlock]: boolean,
  [DictKey.BlackIs1]: boolean,
  [DictKey.StructParents]: number
  [DictKey.SMaskInData]: "SMaskInData",
  [DictKey.Matte]: number[],
  [DictKey.Alt]: string,
  [DictKey.E]: string,
  [DictKey.ActualText]: string,
  [DictKey.WhitePoint]: [number, number, number],
  [DictKey.BlackPoint]: [number, number, number],
  [DictKey.Gamma]: number | [number, number, number],
  [DictKey.EarlyChange]: number,
  [DictKey.ColorTransform]: number,
  [DictKey.Alternate]: Ref | Name | (Ref | Name)[];
  [DictKey.MediaBox]: RectType;
  [DictKey.CropBox]: RectType;
  [DictKey.Q]: number,
  [DictKey.MaxLen]: number,
  [DictKey.Stm]: Ref,
  [DictKey.CFM]: Name,
  [DictKey.DV]: string[] | string | null,
  [DictKey.Ff]: number,
  [DictKey.Opt]: unknown[]
}



export class Ref {

  public num: number;

  public gen: number;

  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }

  toString() {
    // This function is hot, so we make the string as compact as possible.
    // |this.gen| is almost always zero, so we treat that case specially.
    if (this.gen === 0) {
      return `${this.num}R`;
    }
    return `${this.num}R${this.gen}`;
  }

  static fromString(str: string) {
    const ref = RefCache.get(str);
    if (ref) {
      return ref;
    }
    const m = /^(\d+)R(\d*)$/.exec(str);
    if (!m || m[1] === "0") {
      return null;
    }

    RefCache.set(str, new Ref(
      parseInt(m[1]),
      !m[2] ? 0 : parseInt(m[2])
    ))

    return RefCache.get(str)!;
  }

  static get(num: number, gen: number): Ref {
    const key = gen === 0 ? `${num}R` : `${num}R${gen}`;
    const cache = RefCache.get(key);
    if (!cache) {
      RefCache.set(key, new Ref(num, gen));
    }
    return RefCache.get(key)!;
  }
}

// 引用的唯一性由数字(num)和代数(gen)决定
// 每个实例只会存在一个引用
export class RefSet {

  // ref <==> '${num}R${gen}' 二者之间是可以互逆的
  protected _set: Set<string>;

  constructor(parent: RefSet | null = null) {
    this._set = new Set(parent?._set);
  }

  has(ref: Ref | string) {
    return this._set.has(ref.toString());
  }

  put(ref: Ref | string) {
    this._set.add(ref.toString());
  }

  remove(ref: Ref | string) {
    this._set.delete(ref.toString());
  }

  [Symbol.iterator]() {
    return this._set.values();
  }

  clear() {
    this._set.clear();
  }
}

export class RefSetCache<K extends { toString(): string }, V> {

  protected _map = new Map<string, V>();

  constructor() {
  }

  get size() {
    return this._map.size;
  }

  get(ref: K): V | null {
    return this._map.get(ref.toString()) || null;
  }

  has(ref: K) {
    return this._map.has(ref.toString());
  }

  // 为了应对某些糟糕的情况, ref可能不一定是一个Ref，而是一个可以toString的参数
  // 这也是为什么这里要用toString() 而不是直接塞

  // 目前还是要用any作为对象类型，实际上应该要限制any的类型，不能无限制的配置
  put(ref: K, obj: V) {
    this._map.set(ref.toString(), obj);
  }

  putAlias(ref: K, aliasRef: K) {
    this._map.set(ref.toString(), this.get(aliasRef)!);
  }

  [Symbol.iterator]() {
    return this._map.values();
  }

  clear() {
    this._map.clear();
  }

  *items() {
    for (const [ref, value] of this._map) {
      yield [Ref.fromString(ref)!, value] as const;
    }
  }
}

export function isName(v: unknown, name: string) {
  return v instanceof Name && (isNull(name) || v.name === name);
}

export function isCmd(v: unknown, cmd: string) {
  return v instanceof Cmd && (isNull(cmd) || v.cmd === cmd);
}

export function isRefsEqual(v1: Ref, v2: Ref) {
  if (!PlatformHelper.hasDefined() || PlatformHelper.isTesting()) {
    assert(
      v1 instanceof Ref && v2 instanceof Ref,
      "isRefsEqual: Both parameters should be `Ref`s."
    );
  }
  return v1.num === v2.num && v1.gen === v2.gen;
}
