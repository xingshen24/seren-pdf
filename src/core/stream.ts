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

import { BaseStream } from "./base_stream";
import { stringToBytes } from "../shared/util";
import { Dict } from "./primitives";
import { Uint8TypedArray } from "../common/typed_array";

class Stream extends BaseStream {

  public start: number;

  public end: number;

  public bytes: Uint8TypedArray;

  public dict: Dict | null;

  constructor(
    arrayBuffer: Uint8Array<ArrayBuffer> | ArrayBuffer,
    start = 0,
    length: number | null = null,
    dict: Dict | null = null
  ) {
    super();
    this.bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    this.start = start || 0;
    this.pos = this.start;
    this.end = length != undefined ? start + length : this.bytes.length;
    this.dict = dict;
  }

  get length() {
    return this.end - this.start;
  }

  get isEmpty() {
    return this.length === 0;
  }

  getByte() {
    if (this.pos >= this.end) {
      return -1;
    }
    return this.bytes[this.pos++];
  }

  getBytes(length?: number): Uint8TypedArray {
    const bytes = this.bytes;
    const pos = this.pos;
    const strEnd = this.end;

    if (!length) {
      return bytes.subarray(pos, strEnd);
    }
    let end = pos + length;
    if (end > strEnd) {
      end = strEnd;
    }
    this.pos = end;
    return bytes.subarray(pos, end);
  }

  getByteRange(begin: number, end: number) {
    if (begin < 0) {
      begin = 0;
    }
    if (end > this.end) {
      end = this.end;
    }
    return this.bytes.subarray(begin, end);
  }

  reset() {
    this.pos = this.start;
  }

  moveStart() {
    this.start = this.pos;
  }

  makeSubStream(start: number, length: number | null = null, dict: Dict | null = null) {
    return new Stream(this.bytes.buffer, start, length, dict);
  }

  getBaseStreams(): Array<BaseStream> | null {
    return null;
  }
}

class StringStream extends Stream {
  constructor(str: string) {
    super(stringToBytes(str));
  }
}

class NullStream extends Stream {
  constructor() {
    super(new Uint8Array(0));
  }
}

export { NullStream, Stream, StringStream };
