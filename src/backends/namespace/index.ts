import type { BackendDriver } from "../types.ts";
import { NamespaceBackend } from "./backend.ts";
import { NAMESPACE_FIELDS, NAMESPACE_KINDS, parseNamespacePart, type NamespaceConfig } from "./config.ts";

export const namespaceDriver: BackendDriver<NamespaceConfig> = {
  type: "namespace",
  label: "Namespace",
  description: "Macs and Linux machines rented by the minute from Namespace, one for each box. A machine ends when its box is released, or at the plan's longest life.",
  nature: "virtual",
  form: "VM",
  kinds: NAMESPACE_KINDS,
  sharedKinds: ["ios"],
  fields: NAMESPACE_FIELDS,
  setup: { guide: "docs/guide/namespace.md", scripts: [] },
  parse: parseNamespacePart,
  create: (config, context) => new NamespaceBackend(config, context),
};
