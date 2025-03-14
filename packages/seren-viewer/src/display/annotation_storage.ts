/* Copyright 2020 Mozilla Foundation
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
  objectFromMap,
  shadow,
  unreachable,
  AnnotationEditorSerial,
  isNull
} from "seren-common";
import { AnnotationEditor } from "./editor/editor";

export const SerializableEmpty: AnnotationStorageSerializable = Object.freeze({
  map: null,
  hash: "",
  transfer: null,
});

export interface AnnotationStorageSerializable {
  map: Map<string, AnnotationEditorSerial> | null;
  hash: string;
  transfer: Transferable[] | null
}

/**
 * Key/value storage for annotation data in forms.
 */
export class AnnotationStorage {

  #modified = false;

  #modifiedIds: { ids: Set<string>, hash: string } | null = null;

  #storage = new Map<string, Record<string, any>>();

  protected onSetModified: (() => void) | null;

  protected onResetModified: (() => void) | null;

  protected onAnnotationEditor: ((type: string | null) => void) | null;

  constructor() {
    // Callbacks to signal when the modification state is set or reset.
    // This is used by the viewer to only bind on `beforeunload` if forms
    // are actually edited to prevent doing so unconditionally since that
    // can have undesirable effects.
    this.onSetModified = null;
    this.onResetModified = null;
    this.onAnnotationEditor = null;
  }

  /**
   * Get the value for a given key if it exists, or return the default value.
   */
  getValue(key: string, defaultValue: Record<string, any>) {
    const value = this.#storage.get(key);
    if (isNull(value)) {
      return defaultValue;
    }

    return Object.assign(defaultValue, value);
  }

  /**
   * Get the value for a given key.
   */
  getRawValue(key: string) {
    return this.#storage.get(key);
  }

  /**
   * Remove a value from the storage.
   */
  remove(key: string) {
    this.#storage.delete(key);

    if (this.#storage.size === 0) {
      this.resetModified();
    }

    if (typeof this.onAnnotationEditor === "function") {
      for (const value of this.#storage.values()) {
        if (value instanceof AnnotationEditor) {
          return;
        }
      }
      this.onAnnotationEditor(null);
    }
  }

  /**
   * Set the value for a given key
   */
  setValue(key: string, value: Record<string, any>) {
    const obj = this.#storage.get(key);
    let modified = false;
    // 如果已经有这个属性了，就把这个属性加上
    if (obj !== undefined) {
      for (const [entry, val] of Object.entries(value)) {
        if (obj[entry] !== val) {
          modified = true;
          obj[entry] = val;
        }
      }
    } else {
      // 没有就直接往里放
      modified = true;
      this.#storage.set(key, value);
    }
    if (modified) {
      this.#setModified();
    }

    if (
      value instanceof AnnotationEditor &&
      typeof this.onAnnotationEditor === "function"
    ) {
      // 这里需要注意一下，做了一些改动
      // 因为AnnotationEditor本身没有_type类型，但是它的子类有
      // 这边我其实也没有特别好的想法，只能先将就一下，转成any然后读取_type
      this.onAnnotationEditor((value.constructor as any)._type);
    }
  }

  /**
   * Check if the storage contains the given key.
   */
  has(key: string) {
    return this.#storage.has(key);
  }

  getAll() {
    return this.#storage.size > 0 ? objectFromMap(this.#storage) : null;
  }

  setAll(obj: object) {
    for (const [key, val] of Object.entries(obj)) {
      this.setValue(key, val);
    }
  }

  get size() {
    return this.#storage.size;
  }

  #setModified() {
    if (!this.#modified) {
      this.#modified = true;
      if (typeof this.onSetModified === "function") {
        this.onSetModified();
      }
    }
  }

  resetModified() {
    if (this.#modified) {
      this.#modified = false;
      if (typeof this.onResetModified === "function") {
        this.onResetModified();
      }
    }
  }

  get print() {
    return new PrintAnnotationStorage(this);
  }

  /**
   * PLEASE NOTE: Only intended for usage within the API itself.
   */
  get serializable(): AnnotationStorageSerializable {
    return SerializableEmpty;
  }

  get editorStats() {
    let stats = null;
    const typeToEditor = new Map();
    for (const value of this.#storage.values()) {
      if (!(value instanceof AnnotationEditor)) {
        continue;
      }
      const editorStats = value.telemetryFinalData;
      if (!editorStats) {
        continue;
      }
      const { type } = editorStats;
      if (!typeToEditor.has(type)) {
        typeToEditor.set(type, Object.getPrototypeOf(value).constructor);
      }
      stats ||= Object.create(null);
      const map = (stats[type] ||= new Map());
      for (const [key, val] of Object.entries(editorStats)) {
        if (key === "type") {
          continue;
        }
        let counters = map.get(key);
        if (!counters) {
          counters = new Map();
          map.set(key, counters);
        }
        const count = counters.get(val) ?? 0;
        counters.set(val, count + 1);
      }
    }
    for (const [type, editor] of typeToEditor) {
      stats[type] = editor.computeTelemetryFinalData(stats[type]);
    }
    return stats;
  }

  resetModifiedIds() {
    this.#modifiedIds = null;
  }

  get modifiedIds() {
    if (this.#modifiedIds) {
      return this.#modifiedIds;
    }
    const ids = [];
    for (const value of this.#storage.values()) {
      if (
        !(value instanceof AnnotationEditor) ||
        !value.annotationElementId
      ) {
        continue;
      }
      ids.push(value.annotationElementId);
    }
    return (this.#modifiedIds = {
      ids: new Set(ids),
      hash: ids.join(","),
    });
  }
}

/**
 * A special `AnnotationStorage` for use during printing, where the serializable
 * data is *frozen* upon initialization, to prevent scripting from modifying its
 * contents. (Necessary since printing is triggered synchronously in browsers.)
 */
export class PrintAnnotationStorage extends AnnotationStorage {
  #serializable;

  constructor(parent: AnnotationStorage) {
    super();
    const { map, hash, transfer } = parent.serializable;
    // Create a *copy* of the data, since Objects are passed by reference in JS.
    const clone = structuredClone(map, transfer ? { transfer } : undefined);

    this.#serializable = { map: clone, hash, transfer };
  }

  get print() {
    unreachable("Should not call PrintAnnotationStorage.print");
    return super.print;
  }

  /**
   * PLEASE NOTE: Only intended for usage within the API itself.
   * @ignore
   */
  get serializable(): AnnotationStorageSerializable {
    return this.#serializable;
  }

  get modifiedIds() {
    return shadow(this, "modifiedIds", {
      ids: new Set<string>(),
      hash: "",
    });
  }
}
