import type { BackendDriver } from "../types.ts";
import { NamespaceBackend } from "./backend.ts";
import { LONGEST_NAMESPACE_BACKEND_NAME } from "./owner.ts";
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
  setup: { guide: "docs/guide/namespace.md", scripts: [], needs: "A Namespace workspace, a token made with its CLI, and a way for its machines to reach BB." },
  parse: parseNamespacePart,
  several: () => null,
  longestName: LONGEST_NAMESPACE_BACKEND_NAME,
  create: (config, context) => new NamespaceBackend(config, context),
};
