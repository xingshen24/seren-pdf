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

import { ConfigNamespace } from "./config";
import { ConnectionSetNamespace } from "./connection_set";
import { DatasetsNamespace } from "./datasets";
import { LocaleSetNamespace } from "./locale_set";
import { Namespace } from "./namespace";
import { SignatureNamespace } from "./signature";
import { StylesheetNamespace } from "./stylesheet";
import { TemplateNamespace } from "./template";
import { XdpNamespace } from "./xdp";
import { XhtmlNamespace } from "./xhtml";

const NamespaceSetUp = {
  config: ConfigNamespace.DEFAULT,
  connection: ConnectionSetNamespace.DEFAULT,
  datasets: DatasetsNamespace.DEFAULT,
  localeSet: LocaleSetNamespace.DEFAULT,
  signature: SignatureNamespace.DEFAULT,
  stylesheet: StylesheetNamespace.DEFAULT,
  template: TemplateNamespace.DEFAULT,
  xdp: XdpNamespace.DEFAULT,
  xhtml: XhtmlNamespace.DEFAULT,
} as Record<string, Namespace>;

export { NamespaceSetUp };
