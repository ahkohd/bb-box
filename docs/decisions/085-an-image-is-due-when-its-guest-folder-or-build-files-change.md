# An image is due when its guest folder or build files change

Status: accepted
Date: 10 November 2026

Extends [049](049-a-project-image-is-a-script-on-the-standard-image-and-images-are-rebuilt-when-stale.md):
what makes a standard Linux or Android image due.

## Context

Each standard Linux and Android image's record holds a program digest.
bb-box works out the digest a rebuild would record now, and an image
whose record holds another is due: "its guest program or prepare script changed".

The digest covered the identity reset setting, the guest folder's
scripts (`setup/proxmox-lxc/template/guest/*.sh`) and one prepare file
per backend. For Docker and microsandbox that file was
`setup/docker/customize.sh`. The Dockerfile copies more than that into
the images: `start`, `fork-hold` and `gpu-bus-id`. So a change to one of
those, or to the Dockerfile itself, never made a Docker image due. After
forks came to Docker, every Docker image was still "not due", kept no
fork hold, and its forks were refused.

The guest folder also has files that are not scripts, in
`guest/files/`, such as the desktop's probes. A change to one of them
made no image due either.

## Decision

- The program digest covers every file in the guest folder, in its
  subfolders too, not only the scripts.
- For Docker and microsandbox, the prepare digest covers every file the
  Docker build reads from `setup/`: the Dockerfile and each file or
  folder it copies or binds. `setup/docker/image-sources` lists them,
  beside the Dockerfile. A test reads the Dockerfile's copies and binds,
  and fails when the list leaves one out, so a new copy cannot be
  forgotten.
- Both digests leave out only a Mac's metadata: `.DS_Store` files and the
  AppleDouble `._` files the tar on a Mac can add to a copy. Every other
  file counts, hidden ones too, such as a `.guest-config`. The prepare
  digest also leaves out the pin files, `pins.json`, `apt-snapshot` and
  `desktop-pins.tsv`, which the pins' digest covers and which a refresh
  replaces with newer versions.
- Files are hashed by their path, in byte order, with the path before
  each file's contents.
- `setup/docker/build.sh` works out the prepare digest from the same list
  by the same rule, and gives it to the build as `IMAGE_SOURCES_SHA256`.
  `customize.sh` records it as `PREPARE`, and `image-record.sh` hashes the
  build's copy of the guest folder by the same rule. So a fresh build
  records the digest bb-box works out, and is not due at once.
- Boat stages only the files its template's build reads, and gives the
  build no prepare digest. The program digest bb-box works out for a boat
  template covers the guest files boat stages, with an empty prepare
  digest, as boat's build records it. Boat does not judge its templates by
  this digest: it builds a template again when its template key changes,
  and that key covers every file boat stages.

## Consequences

- A change to `start`, `fork-hold`, `gpu-bus-id`, the Dockerfile or any
  guest file makes the images built from it due, and the nightly rebuild
  brings them up to date.
- Every standard image whose record holds a program digest is due once
  after this change, because its record was made by the earlier rule:
  the Linux and Android images on Docker, microsandbox, Proxmox LXC,
  Proxmox QEMU and Tart. The nightly rebuilds take them one at a time,
  most needed first, and start none after 4 hours, so on a BB with many
  images they can take more than one night. An image built before records held a
  program digest is not due for this.
- A change to `start`, `fork-hold` or `gpu-bus-id` now runs the whole
  Docker build again, not only its last layers, because the record is
  written in the layer the guest scripts make.
- The Docker build binds all of `setup/proxmox-lxc/template`, so a change
  to any file in it, the Proxmox LXC template's own `build.sh` included,
  makes the Docker images due.
- On Proxmox LXC, Proxmox QEMU and Tart the prepare digest is still only
  the backend's build script. A change to another file their builds read
  outside the guest folder, such as `baseline-packages.txt` or
  `fetch-artifacts.sh`, does not make their images due by itself.
- Each boat template is built again once after this change, as its
  template key covers `image-record.sh`, which this change edits. Its
  reason is that BB Box's template scripts changed.
- An image built by running `docker build` directly, not through
  `build.sh`, records no prepare digest, so it is due until it is rebuilt.
