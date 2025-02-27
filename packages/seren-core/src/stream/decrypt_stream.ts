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

import { Uint8TypedArray } from "seren-common";
import { BaseStream } from "./base_stream";
import { DecodeStream } from "./decode_stream";

const chunkSize = 512;

export class DecryptStream extends DecodeStream {

  public stream: BaseStream;

  protected initialized: boolean;

  protected nextChunk: Uint8TypedArray | null;

  protected decrypt: (data: Uint8TypedArray, finalize: boolean) => Uint8TypedArray;

  constructor(
    stream: BaseStream, maybeLength: number,
    decrypt: (data: Uint8TypedArray, finalize: boolean) => Uint8TypedArray
  ) {
    super(maybeLength);

    this.stream = stream;
    this.dict = stream.dict;
    this.decrypt = decrypt;
    this.nextChunk = null;
    this.initialized = false;
  }

  readBlock() {
    let chunk;
    if (this.initialized) {
      chunk = this.nextChunk;
    } else {
      chunk = this.stream.getBytes(chunkSize);
      this.initialized = true;
    }
    if (!chunk || chunk.length === 0) {
      this.eof = true;
      return;
    }
    this.nextChunk = this.stream.getBytes(chunkSize);
    const hasMoreData = this.nextChunk?.length > 0;

    const decrypt = this.decrypt;
    chunk = decrypt(chunk, !hasMoreData);

    const bufferLength = this.bufferLength;
    const newLength = bufferLength + chunk.length;
    const buffer = this.ensureBuffer(newLength);
    buffer.set(chunk, bufferLength);
    this.bufferLength = newLength;
  }
}
