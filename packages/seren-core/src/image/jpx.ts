/* Copyright 2024 Mozilla Foundation
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
  BaseException,
  warn,
  PlatformHelper,
  Uint8TypedArray,
  JpxDecoderOptions
} from "seren-common";
// 这里仔细研究一下，如何引入外部的部件
// openjpeg这个组件，最后还是会被打到worker文件里的，而非单独一个文件
import { Stream } from "../stream/stream";
import { BaseStream } from "../stream/base_stream";
import { OpenJPEG, OpenJPEGModule } from "seren-openjpeg"

export class JpxError extends BaseException {
  constructor(msg: string) {
    super(msg, "JpxError");
  }
}

export class JpxImage {

  static #module: OpenJPEGModule | null = null;

  static decode(data: Uint8TypedArray, decoderOptions: JpxDecoderOptions | null) {
    const options = decoderOptions ?? {};
    this.#module ||= OpenJPEG({ warn });
    const imageData = this.#module!.decode(
      <Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>>data, options
    );
    if (typeof imageData === "string") {
      throw new JpxError(imageData);
    }
    return imageData;
  }

  static cleanup() {
    this.#module = null;
  }

  static parseImageProperties(stream: BaseStream) {
    if (PlatformHelper.hasImageDecoders()) {
      if (stream instanceof ArrayBuffer || ArrayBuffer.isView(stream)) {
        stream = new Stream(<ArrayBuffer>stream);
      } else {
        throw new JpxError("Invalid data format, must be a TypedArray.");
      }
    }
    // No need to use OpenJPEG here since we're only getting very basic
    // information which are located in the first bytes of the file.
    let newByte = stream.getByte();
    while (newByte >= 0) {
      const oldByte = newByte;
      newByte = stream.getByte();
      const code = (oldByte << 8) | newByte;
      // Image and tile size (SIZ)
      if (code === 0xff51) {
        stream.skip(4);
        const Xsiz = stream.getInt32() >>> 0; // Byte 4
        const Ysiz = stream.getInt32() >>> 0; // Byte 8
        const XOsiz = stream.getInt32() >>> 0; // Byte 12
        const YOsiz = stream.getInt32() >>> 0; // Byte 16
        stream.skip(16);
        const Csiz = stream.getUint16(); // Byte 36
        return {
          width: Xsiz - XOsiz,
          height: Ysiz - YOsiz,
          // Results are always returned as `Uint8ClampedArray`s.
          bitsPerComponent: 8,
          componentsCount: Csiz,
        };
      }
    }
    throw new JpxError("No size marker found in JPX stream");
  }
}

