/* Copyright 2018 Mozilla Foundation
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

// The code for XMLParserBase copied from
// https://github.com/mozilla/shumway/blob/16451d8836fa85f4b16eeda8b4bda2fa9e2b22b0/src/avm2/natives/xml.ts

import { encodeToXmlString } from "./core_utils";

export const XMLParserErrorCode = {
  NoError: 0,
  EndOfDocument: -1,
  UnterminatedCdat: -2,
  UnterminatedXmlDeclaration: -3,
  UnterminatedDoctypeDeclaration: -4,
  UnterminatedComment: -5,
  MalformedElement: -6,
  OutOfMemory: -7,
  UnterminatedAttributeValue: -8,
  UnterminatedElement: -9,
  ElementNeverBegun: -10,
};

function isWhitespace(s: string, index: number) {
  const ch = s[index];
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function isWhitespaceString(s: string) {
  for (let i = 0, ii = s.length; i < ii; i++) {
    if (!isWhitespace(s, i)) {
      return false;
    }
  }
  return true;
}

interface XMLTagProperty {

  name: string;

  value: string;

}

export abstract class XMLParserBase {
  _resolveEntities(s: string) {
    return s.replaceAll(/&([^;]+);/g, (_all, entity) => {
      if (entity.substring(0, 2) === "#x") {
        return String.fromCodePoint(parseInt(entity.substring(2), 16));
      } else if (entity.substring(0, 1) === "#") {
        return String.fromCodePoint(parseInt(entity.substring(1), 10));
      }
      switch (entity) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      return this.onResolveEntity(entity);
    });
  }

  _parseContent(s: string, start: number) {
    const attributes: XMLTagProperty[] = [];
    let pos = start;

    function skipWs() {
      while (pos < s.length && isWhitespace(s, pos)) {
        ++pos;
      }
    }

    while (
      pos < s.length &&
      !isWhitespace(s, pos) &&
      s[pos] !== ">" &&
      s[pos] !== "/"
    ) {
      ++pos;
    }
    const name = s.substring(start, pos);
    skipWs();
    while (
      pos < s.length &&
      s[pos] !== ">" &&
      s[pos] !== "/" &&
      s[pos] !== "?"
    ) {
      skipWs();
      let attrName = "",
        attrValue = "";
      while (pos < s.length && !isWhitespace(s, pos) && s[pos] !== "=") {
        attrName += s[pos];
        ++pos;
      }
      skipWs();
      if (s[pos] !== "=") {
        return null;
      }
      ++pos;
      skipWs();
      const attrEndChar = s[pos];
      if (attrEndChar !== '"' && attrEndChar !== "'") {
        return null;
      }
      const attrEndIndex = s.indexOf(attrEndChar, ++pos);
      if (attrEndIndex < 0) {
        return null;
      }
      attrValue = s.substring(pos, attrEndIndex);
      attributes.push({
        name: attrName,
        value: this._resolveEntities(attrValue),
      });
      pos = attrEndIndex + 1;
      skipWs();
    }
    return {
      name,
      attributes,
      parsed: pos - start,
    };
  }

  _parseProcessingInstruction(s: string, start: number) {
    let pos = start;

    function skipWs() {
      while (pos < s.length && isWhitespace(s, pos)) {
        ++pos;
      }
    }

    while (
      pos < s.length &&
      !isWhitespace(s, pos) &&
      s[pos] !== ">" &&
      s[pos] !== "?" &&
      s[pos] !== "/"
    ) {
      ++pos;
    }
    const name = s.substring(start, pos);
    skipWs();
    const attrStart = pos;
    while (pos < s.length && (s[pos] !== "?" || s[pos + 1] !== ">")) {
      ++pos;
    }
    const value = s.substring(attrStart, pos);
    return {
      name,
      value,
      parsed: pos - start,
    };
  }

  parseXml(s: string) {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      let j = i;
      if (ch === "<") {
        ++j;
        const ch2 = s[j];
        let q: number;
        switch (ch2) {
          case "/":
            ++j;
            q = s.indexOf(">", j);
            if (q < 0) {
              this.onError(XMLParserErrorCode.UnterminatedElement);
              return;
            }
            this.onEndElement(s.substring(j, q));
            j = q + 1;
            break;
          case "?":
            ++j;
            const pi = this._parseProcessingInstruction(s, j);
            if (s.substring(j + pi.parsed, j + pi.parsed + 2) !== "?>") {
              this.onError(XMLParserErrorCode.UnterminatedXmlDeclaration);
              return;
            }
            this.onPi(pi.name, pi.value);
            j += pi.parsed + 2;
            break;
          case "!":
            if (s.substring(j + 1, j + 3) === "--") {
              q = s.indexOf("-->", j + 3);
              if (q < 0) {
                this.onError(XMLParserErrorCode.UnterminatedComment);
                return;
              }
              this.onComment(s.substring(j + 3, q));
              j = q + 3;
            } else if (s.substring(j + 1, j + 8) === "[CDATA[") {
              q = s.indexOf("]]>", j + 8);
              if (q < 0) {
                this.onError(XMLParserErrorCode.UnterminatedCdat);
                return;
              }
              this.onCdata(s.substring(j + 8, q));
              j = q + 3;
            } else if (s.substring(j + 1, j + 8) === "DOCTYPE") {
              const q2 = s.indexOf("[", j + 8);
              let complexDoctype = false;
              q = s.indexOf(">", j + 8);
              if (q < 0) {
                this.onError(XMLParserErrorCode.UnterminatedDoctypeDeclaration);
                return;
              }
              if (q2 > 0 && q > q2) {
                q = s.indexOf("]>", j + 8);
                if (q < 0) {
                  this.onError(
                    XMLParserErrorCode.UnterminatedDoctypeDeclaration
                  );
                  return;
                }
                complexDoctype = true;
              }
              const doctypeContent = s.substring(
                j + 8,
                q + (complexDoctype ? 1 : 0)
              );
              this.onDoctype(doctypeContent);
              j = q + (complexDoctype ? 2 : 1);
            } else {
              this.onError(XMLParserErrorCode.MalformedElement);
              return;
            }
            break;
          default:
            const content = this._parseContent(s, j);
            if (content === null) {
              this.onError(XMLParserErrorCode.MalformedElement);
              return;
            }
            let isClosed = false;
            if (
              s.substring(j + content.parsed, j + content.parsed + 2) === "/>"
            ) {
              isClosed = true;
            } else if (
              s.substring(j + content.parsed, j + content.parsed + 1) !== ">"
            ) {
              this.onError(XMLParserErrorCode.UnterminatedElement);
              return;
            }
            this.onBeginElement(content.name, content.attributes, isClosed);
            j += content.parsed + (isClosed ? 2 : 1);
            break;
        }
      } else {
        while (j < s.length && s[j] !== "<") {
          j++;
        }
        const text = s.substring(i, j);
        this.onText(this._resolveEntities(text));
      }
      i = j;
    }
  }

  onResolveEntity(name: string) {
    return `&${name};`;
  }

  onPi(_name: string, _value: string) { };

  onComment(_text: string) { };

  abstract onCdata(_text: string): void;

  onDoctype(_doctypeContent: string) { }

  abstract onText(_text: string): void;

  abstract onBeginElement(_name: string, _attributes: XMLTagProperty[], _isEmpty: boolean): void;

  abstract onEndElement(_name: string): void;

  abstract onError(_code: number): void;
}

export class SimpleDOMNode {

  public nodeName: string;

  public nodeValue: string | null;

  public parentNode: SimpleDOMNode | null;

  public childNodes: SimpleDOMNode[] = [];

  public attributes: XMLTagProperty[] = [];

  constructor(nodeName: string, nodeValue: string | null = null) {
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
    // 原来的代码里是null，我想应该也是null，或者是要
    this.parentNode = null;
  }

  get firstChild() {
    return this.childNodes?.[0];
  }

  get nextSibling(): SimpleDOMNode | undefined {
    const childNodes = this.parentNode!.childNodes;
    if (!childNodes) {
      return undefined;
    }
    const index = childNodes.indexOf(this);
    if (index === -1) {
      return undefined;
    }
    return childNodes[index + 1];
  }

  get textContent(): string {
    if (!this.childNodes) {
      return this.nodeValue || "";
    }
    return this.childNodes
      .map(function (child) {
        return child.textContent;
      })
      .join("");
  }

  get children() {
    return this.childNodes || [];
  }

  hasChildNodes() {
    return this.childNodes?.length > 0;
  }

  /**
   * Search a node in the tree with the given path
   * foo.bar[nnn], i.e. find the nnn-th node named
   * bar under a node named foo.
   *
   * @param {Array} paths - an array of objects as
   * returned by {parseXFAPath}.
   * @param {number} pos - the current position in
   * the paths array.
   * @returns {SimpleDOMNode} The node corresponding
   * to the path or null if not found.
   */
  searchNode(paths: { name: string, pos: number }[], pos: number): SimpleDOMNode | null {
    if (pos >= paths.length) {
      return this;
    }

    const component = paths[pos];
    if (component.name.startsWith("#") && pos < paths.length - 1) {
      // If it starts with a # then it's a class which is not a concept for
      // datasets elements (https://www.pdfa.org/norm-refs/XFA-3_3.pdf#page=96).
      return this.searchNode(paths, pos + 1);
    }
    const stack = [] as [SimpleDOMNode, number | null][];
    let node: SimpleDOMNode = this;

    while (true) {
      if (component.name === node.nodeName) {
        if (component.pos === 0) {
          const res = node.searchNode(paths, pos + 1);
          if (res !== null) {
            return res;
          }
        } else if (stack.length === 0) {
          return null;
        } else {
          const [parent] = stack.pop()!;
          let siblingPos = 0;
          for (const child of parent.childNodes) {
            if (component.name === child.nodeName) {
              if (siblingPos === component.pos) {
                return child.searchNode(paths, pos + 1);
              }
              siblingPos++;
            }
          }
          // We didn't find the correct sibling
          // so just return the first found node
          return node.searchNode(paths, pos + 1);
        }
      }

      if (node.childNodes?.length > 0) {
        stack.push([node, 0]);
        node = node.childNodes[0];
      } else if (stack.length === 0) {
        return null;
      } else {
        while (stack.length !== 0) {
          const [parent, currentPos] = stack.pop()!;
          const newPos = currentPos! + 1;
          if (newPos < parent.childNodes.length) {
            stack.push([parent, newPos]);
            node = parent.childNodes[newPos];
            break;
          }
        }
        if (stack.length === 0) {
          return null;
        }
      }
    }
  }

  dump(buffer: string[]) {
    if (this.nodeName === "#text") {
      buffer.push(encodeToXmlString(this.nodeValue!));
      return;
    }

    buffer.push(`<${this.nodeName}`);
    if (this.attributes) {
      for (const attribute of this.attributes) {
        buffer.push(
          ` ${attribute.name}="${encodeToXmlString(attribute.value)}"`
        );
      }
    }
    if (this.hasChildNodes()) {
      buffer.push(">");
      for (const child of this.childNodes) {
        child.dump(buffer);
      }
      buffer.push(`</${this.nodeName}>`);
    } else if (this.nodeValue) {
      buffer.push(`>${encodeToXmlString(this.nodeValue)}</${this.nodeName}>`);
    } else {
      buffer.push("/>");
    }
  }
}

export class SimpleXMLParser extends XMLParserBase {

  protected _stack: SimpleDOMNode[][] | null;

  protected _currentFragment: SimpleDOMNode[] | null;

  protected _errorCode = XMLParserErrorCode.NoError;

  protected _hasAttributes: boolean;

  protected _lowerCaseName: boolean;

  constructor(hasAttributes = false, lowerCaseName = false) {
    super();
    this._currentFragment = null;
    this._stack = null;
    this._hasAttributes = hasAttributes;
    this._lowerCaseName = lowerCaseName;
  }

  parseFromString(data: string) {
    this._currentFragment = [];
    this._stack = [];
    this._errorCode = XMLParserErrorCode.NoError;

    this.parseXml(data);

    if (this._errorCode !== XMLParserErrorCode.NoError) {
      return undefined; // return undefined on error
    }

    // We should only have one root.
    const [documentElement] = this._currentFragment;
    if (!documentElement) {
      return undefined; // Return undefined if no root was found.
    }
    return { documentElement };
  }

  onText(text: string) {
    if (isWhitespaceString(text)) {
      return;
    }
    const node = new SimpleDOMNode("#text", text);
    this._currentFragment!.push(node);
  }

  onCdata(text: string) {
    const node = new SimpleDOMNode("#text", text);
    this._currentFragment!.push(node);
  }

  onBeginElement(name: string, attributes: XMLTagProperty[], isEmpty: boolean) {
    if (this._lowerCaseName) {
      name = name.toLowerCase();
    }
    const node = new SimpleDOMNode(name);
    node.childNodes = [];
    if (this._hasAttributes) {
      node.attributes = attributes;
    }
    this._currentFragment!.push(node);
    if (isEmpty) {
      return;
    }
    this._stack!.push(this._currentFragment!);
    this._currentFragment = node.childNodes;
  }

  onEndElement(_name: string): SimpleDOMNode | null {
    this._currentFragment = this._stack!.pop() || [];
    const lastElement = this._currentFragment!.at(-1);
    if (!lastElement) {
      return null;
    }
    for (const childNode of lastElement.childNodes) {
      childNode.parentNode = lastElement;
    }
    return lastElement;
  }

  onError(code: number) {
    this._errorCode = code;
  }

}
