import type { BackendConfig, Document, HostConfig, SecretState } from "./data";

export type Path = string;

export function isSecretState(value: unknown): value is SecretState {
  return typeof value === "object" && value !== null && "set" in value && "version" in value;
}

export function same(a: unknown, b: unknown): boolean {
  if (isSecretState(a) && isSecretState(b)) return a.set === b.set && a.version === b.version;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function hostOf(backend: BackendConfig | undefined, name: string): HostConfig | undefined {
  return backend?.hosts?.find((host) => host.name === name);
}

export function readPath(doc: Document, path: Path): unknown {
  const parts = path.split("/");
  const [root, id, section, key, sub, subKey] = parts;
  if (root === "backends") {
    const backend = doc.backends.find((each) => each.id === id);
    if (!backend) return undefined;
    if (section === "enabled") return backend.enabled;
    if (section === "label") return backend.label;
    if (section === "fields") return backend.fields[key!];
    if (section === "warm") return backend.warm?.[key!] ?? 0;
    if (section === "hosts") {
      const host = hostOf(backend, key!);
      if (sub === undefined) return host ?? null;
      if (sub === "enabled") return host?.enabled;
      if (sub === "fields") return host?.fields[subKey!];
    }
    return undefined;
  }
  if (root === "kinds") {
    const kind = doc.kinds[id!];
    if (!kind) return undefined;
    if (section === "presets") return kind.presets[key as "small"][sub as "cores"];
    if (section === "largest") return kind.largest[key as "cores"];
    return kind[section as "enabled"];
  }
  if (root === "general") {
    if (id === "tailnet") return doc.general.tailnet[section as "mode"];
    return doc.general[id as "defaultKind"];
  }
  if (root === "monitor") return doc.monitor[id as "enabled"];
  if (root === "files") {
    if (path.includes("@new-")) return undefined;
    return doc.general.files.find((file) => file.path === decodeURIComponent(path.slice("files/".length)))?.content;
  }
  return undefined;
}

function withBackend(doc: Document, id: string, change: (backend: BackendConfig) => BackendConfig): Document {
  return { ...doc, backends: doc.backends.map((each) => (each.id === id ? change(each) : each)) };
}

export function writePath(doc: Document, path: Path, value: unknown): Document {
  const [root, id, section, key, sub, subKey] = path.split("/");
  if (root === "backends") {
    return withBackend(doc, id!, (backend) => {
      if (section === "enabled") return { ...backend, enabled: value as boolean };
      if (section === "label") return { ...backend, label: (value as string) || undefined };
      if (section === "fields") {
        const fields = { ...backend.fields };
        if (value === undefined) delete fields[key!];
        else fields[key!] = value as never;
        return { ...backend, fields };
      }
      if (section === "warm") return { ...backend, warm: { ...backend.warm, [key!]: value as number } };
      if (section === "hosts") {
        const hosts = [...(backend.hosts ?? [])];
        const at = hosts.findIndex((host) => host.name === key);
        if (sub === undefined) {
          if (value === null) return { ...backend, hosts: hosts.filter((host) => host.name !== key) };
          if (at >= 0) hosts[at] = value as HostConfig;
          else hosts.push(value as HostConfig);
          return { ...backend, hosts };
        }
        if (at < 0) return backend;
        const host = hosts[at]!;
        const hostFields = { ...host.fields } as Record<string, unknown>;
        if (value === undefined) delete hostFields[subKey!];
        else hostFields[subKey!] = value;
        hosts[at] = sub === "enabled" ? { ...host, enabled: value as boolean } : { ...host, fields: hostFields as HostConfig["fields"] };
        return { ...backend, hosts };
      }
      return backend;
    });
  }
  if (root === "kinds") {
    const kind = doc.kinds[id!]!;
    let next = kind;
    if (section === "presets") next = { ...kind, presets: { ...kind.presets, [key!]: { ...kind.presets[key as "small"], [sub!]: value } } };
    else if (section === "largest") next = { ...kind, largest: { ...kind.largest, [key!]: value } };
    else next = { ...kind, [section!]: value };
    return { ...doc, kinds: { ...doc.kinds, [id!]: next } };
  }
  if (root === "general") {
    if (id === "tailnet") return { ...doc, general: { ...doc.general, tailnet: { ...doc.general.tailnet, [section!]: value } } };
    return { ...doc, general: { ...doc.general, [id!]: value } };
  }
  if (root === "monitor") return { ...doc, monitor: { ...doc.monitor, [id!]: value } };
  if (root === "files" && value === null) {
    const filePath = decodeURIComponent(path.slice("files/".length));
    return { ...doc, general: { ...doc.general, files: doc.general.files.filter((file) => file.path !== filePath) } };
  }
  return doc;
}

export function backendPaths(backend: BackendConfig, fieldKeys: readonly string[], hostKeys: readonly string[]): Path[] {
  const paths = fieldKeys.map((key) => `backends/${backend.id}/fields/${key}`);
  for (const host of backend.hosts ?? []) {
    paths.push(`backends/${backend.id}/hosts/${host.name}`);
    for (const key of hostKeys) paths.push(`backends/${backend.id}/hosts/${host.name}/fields/${key}`);
  }
  return paths;
}
