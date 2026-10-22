import type { BackendDriver } from "../types.ts";
import { NamespaceBackend } from "./backend.ts";
import { NAMESPACE_FIELDS, NAMESPACE_KINDS, parseNamespacePart, type NamespaceConfig } from "./config.ts";

export const namespaceDriver: BackendDriver<NamespaceConfig> = {
  type: "namespace",
  label: "Namespace",
  description: "Macs rented by the minute from Namespace, one machine for each box, ended when the box is released or at the plan's longest life.",
  nature: "virtual",
  form: "VM",
  kinds: NAMESPACE_KINDS,
  fields: NAMESPACE_FIELDS,
  setup: { guide: "docs/research/cloud-hosts.md", scripts: [] },
  parse: parseNamespacePart,
  create: (config, context) => new NamespaceBackend(config, context),
};
