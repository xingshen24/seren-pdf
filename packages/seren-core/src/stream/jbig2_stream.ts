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

import { Uint8TypedArray, shadow, DictKey, Dict } from "seren-common";
import { BaseStream, emptyBuffer } from "./base_stream";
import { DecodeStream } from "./decode_stream";
import { Jbig2Image } from "../image/jbig2";
import { DictImpl } from "../document/dict_impl";

/**
 * For JBIG2's we use a library to decode these images and
 * the stream behaves like all the other DecodeStreams.
 */
export class Jbig2Stream extends DecodeStream {

  protected maybeLength: number;

  protected params: Dict | null;

  public stream: BaseStream;

  constructor(stream: BaseStream, maybeLength: number, params: Dict | null) {
    super(maybeLength);

    this.stream = stream;
    this.dict = stream.dict;
    this.maybeLength = maybeLength;
    this.params = params;
  }

  get bytes(): Uint8TypedArray {
    // If `this.maybeLength` is null, we'll get the entire stream.
    return shadow(this, "bytes", this.stream.getBytes(this.maybeLength));
  }

  ensureBuffer(_requested: number) {
    // No-op, since `this.readBlock` will always parse the entire image and
    // directly insert all of its data into `this.buffer`.
    return emptyBuffer;
  }

  readBlock() {
    this.decodeImage();
  }

  decodeImage(bytes: Uint8TypedArray | null = null) {
    if (this.eof) {
      return this.buffer;
    }
    bytes ||= this.bytes;
    const jbig2Image = new Jbig2Image();

    const chunks: { data: Uint8TypedArray, start: number, end: number }[] = [];
    if (this.params instanceof DictImpl) {
      const globalsStream = this.params.getValue(DictKey.JBIG2Globals);
      if (globalsStream instanceof BaseStream) {
        const globals = globalsStream.getBytes();
        chunks.push({ data: globals, start: 0, end: globals.length });
      }
    }
    chunks.push({ data: bytes, start: 0, end: bytes.length });
    const data = jbig2Image.parseChunks(chunks)!;
    const dataLength = data.length;

    // JBIG2 had black as 1 and white as 0, inverting the colors
    for (let i = 0; i < dataLength; i++) {
      data[i] ^= 0xff;
    }

    this.buffer = data;
    this.bufferLength = dataLength;
    this.eof = true;

    return this.buffer;
  }

  get canAsyncDecodeImageFromBuffer() {
    return this.stream.isAsync;
  }
}