import type { BackendDriver } from "../types.ts";
import { DockerBackend } from "./backend.ts";
import { DOCKER_FIELDS, DOCKER_KINDS, parseDockerPart, type DockerConfig } from "./config.ts";

export const dockerDriver: BackendDriver<DockerConfig> = {
  type: "docker",
  label: "Docker",
  description: "Linux boxes, with or without a desktop, as containers on a Docker host. It needs only Docker.",
  nature: "virtual",
  form: "Docker",
  kinds: DOCKER_KINDS,
  fields: DOCKER_FIELDS,
  setup: {
    guide: "setup/docker/README.md",
    scripts: ["setup/docker/build.sh"],
  },
  parse: parseDockerPart,
  create: (config, context) => new DockerBackend(config, context),
};
