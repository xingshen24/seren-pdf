/* Copyright 2021 Mozilla Foundation
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

import { DictKey, Ref, RefSet, warn, Dict, XRef } from "seren-common";
import { BaseStream } from "../stream/base_stream";
import { MissingDataException } from "../utils/core_utils";
import { XRefImpl } from "../document/xref";
import { ChunkedStream } from "../stream/chunked_stream";
import { DictImpl } from "../document/dict_impl";

function mayHaveChildren(value: unknown) {
  return (
    value instanceof Ref ||
    value instanceof DictImpl ||
    value instanceof BaseStream ||
    Array.isArray(value)
  );
}

function addChildren(node: Dict | BaseStream | object | object[], nodesToVisit: object[]) {
  if (node instanceof DictImpl) {
    node = node.getRawValues();
  } else if (node instanceof BaseStream) {
    node = node.dict!.getRawValues();
  } else if (!Array.isArray(node)) {
    return;
  }
  for (const rawValue of <object[]>node) {
    if (mayHaveChildren(rawValue)) {
      nodesToVisit.push(rawValue);
    }
  }
}

/**
 * A helper for loading missing data in `Dict` graphs. It traverses the graph
 * depth first and queues up any objects that have missing data. Once it has
 * has traversed as many objects that are available it attempts to bundle the
 * missing data requests and then resume from the nodes that weren't ready.
 *
 * NOTE: It provides protection from circular references by keeping track of
 * loaded references. However, you must be careful not to load any graphs
 * that have references to the catalog or other pages since that will cause the
 * entire PDF document object graph to be traversed.
 */
export class ObjectLoader {

  protected dict: Dict;

  protected keys: string[]

  protected xref: XRef;

  protected refSet: RefSet | null;

  constructor(dict: Dict, keys: string[], xref: XRef) {
    this.dict = dict;
    this.keys = keys;
    this.xref = xref;
    this.refSet = null;
  }

  async load() {
    // Don't walk the graph if all the data is already loaded.
    if ((<XRefImpl>this.xref).stream.isDataLoaded) {
      return undefined;
    }

    const { keys, dict } = this;
    this.refSet = new RefSet();
    // Setup the initial nodes to visit.
    const nodesToVisit: object[] = [];
    for (const key of keys) {
      const rawValue = dict.getRaw(<DictKey>key);
      // Skip nodes that are guaranteed to be empty.
      if (rawValue != null) {
        nodesToVisit.push(rawValue);
      }
    }
    return this._walk(nodesToVisit);
  }

  async _walk(nodesToVisit: object[]): Promise<void | ChunkedStream> {
    const nodesToRevisit = [];
    const pendingRequests = [];
    // DFS walk of the object graph.
    while (nodesToVisit.length) {
      let currentNode = nodesToVisit.pop();

      // Only references or chunked streams can cause missing data exceptions.
      if (currentNode instanceof Ref) {
        // Skip nodes that have already been visited.
        if (this.refSet!.has(currentNode)) {
          continue;
        }
        try {
          this.refSet!.put(currentNode);
          currentNode = <object>this.xref.fetch(currentNode);
        } catch (ex) {
          if (!(ex instanceof MissingDataException)) {
            warn(`ObjectLoader._walk - requesting all data: "${ex}".`);
            this.refSet = null;

            const { manager } = <ChunkedStream>(<XRefImpl>this.xref).stream;
            return manager.requestAllChunks();
          }
          nodesToRevisit.push(currentNode!);
          pendingRequests.push({ begin: ex.begin, end: ex.end });
        }
      }
      if (currentNode instanceof BaseStream) {
        const baseStreams = currentNode.getBaseStreams();
        if (baseStreams) {
          let foundMissingData = false;
          for (const stream of baseStreams) {
            if (stream.isDataLoaded) {
              continue;
            }
            foundMissingData = true;
            pendingRequests.push({ begin: stream.start, end: stream.end });
          }
          if (foundMissingData) {
            nodesToRevisit.push(currentNode);
          }
        }
      }

      addChildren(currentNode!, nodesToVisit);
    }

    if (pendingRequests.length) {
      await (<ChunkedStream>(<XRefImpl>this.xref).stream).manager.requestRanges(pendingRequests);

      for (const node of nodesToRevisit) {
        // Remove any reference nodes from the current `RefSet` so they
        // aren't skipped when we revist them.
        if (node instanceof Ref) {
          this.refSet!.remove(node);
        }
      }
      return this._walk(nodesToRevisit);
    }
    // Everything is loaded.
    this.refSet = null;
    return undefined;
  }
}
