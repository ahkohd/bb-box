# Third-party software

bb-box's own code is in this repository. This page lists the software of others that it uses:

- what the plugin bundles
- what the documentation site serves
- what it installs on a host
- what it fetches into a box to make a recording's clip
- what its setup scripts put in box images

bb-box does not redistribute the software it installs on hosts or puts in images. Each piece is downloaded from its publisher when you set up a host or build an image, and most are checked against a SHA-256 pinned in this repository. Each is under its own licence, which applies to whoever builds the image.

## In the plugin

| Software | Licence | Notes |
| --- | --- | --- |
| [noVNC](https://github.com/novnc/noVNC) 1.7.0, from npm (`@novnc/novnc`) | Mozilla Public License 2.0; the pako code it includes is under the MIT licence | The desktop viewer, unchanged. Its source and licence texts are in `node_modules/@novnc/novnc` after `npm install`. The video viewer is bb-box's own code, which uses noVNC's keyboard handling. |
| [xterm.js](https://github.com/xtermjs/xterm.js) and its fit add-on (`@xterm/xterm`, `@xterm/addon-fit`) | MIT | The terminal. `src/app/xterm-css.ts` is a copy of xterm.js's stylesheet, with its notice. |
| `zod`, `undici`, `@radix-ui/react-slot` | MIT | |
| [Hugeicons](https://github.com/hugeicons/hugeicons-react)' free icons and React component (`@hugeicons/core-free-icons`, `@hugeicons/react`) | MIT | The Monitor's icons (066). |
| [bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor) | MIT | The files view is this plugin's explorer, tabs, editor, search, go to file and find bar, ported into the panel. bb-box reads and writes the box user's files. The notice is below. |

### bb-plugin-files-editor

Copyright (c) 2026 AbdElrahman Telb

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

React, Radix's menus and dialogs, and the other packages BB shares with plugins come from BB at runtime. bb-box does not bundle them. The licence texts of everything bundled are in its package in `node_modules` after `npm install`.

`components/ui` is BB's own components, vendored into this repository. The files carry no separate licence notice.

## In the documentation site

The site in `site/` is built from these packages. Its pages carry their code, styles and fonts.

| Software | Licence | Notes |
| --- | --- | --- |
| [Inter](https://github.com/rsms/inter), from npm (`@fontsource-variable/inter`) 5.3.0 | SIL Open Font License 1.1 | The site's typeface, served from the site itself as WOFF2 files, unchanged. Copyright 2016 The Inter Project Authors. The licence text is in [`site/public/licenses/inter-OFL.txt`](site/public/licenses/inter-OFL.txt), which the built site serves at `licenses/inter-OFL.txt` with the fonts. |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), from npm (`@fontsource-variable/jetbrains-mono`) 5.3.0 | SIL Open Font License 1.1 | The site's monospaced typeface, for code, commands and its character drawings, served from the site itself as WOFF2 files, unchanged. Copyright 2020 The JetBrains Mono Project Authors. The licence text is in [`site/public/licenses/jetbrains-mono-OFL.txt`](site/public/licenses/jetbrains-mono-OFL.txt), which the built site serves at `licenses/jetbrains-mono-OFL.txt` with the fonts. |
| [Astro](https://github.com/withastro/astro) and [Starlight](https://github.com/withastro/starlight) (`astro`, `@astrojs/starlight`) | MIT | The site's framework and its documentation theme. |
| [Pagefind](https://github.com/CloudCannon/pagefind) (`pagefind`, `@pagefind/default-ui`) | MIT | The site's search. |
| [Expressive Code](https://github.com/expressive-code/expressive-code) (`astro-expressive-code`) | MIT | The site's code blocks. |

`sharp`, under the Apache License 2.0, resizes the site's images while it is built, and is not part of the built site. The licence texts of the site's packages are in their packages in `site/node_modules` after `npm ci` there.

## In the tests

| Software | Licence | Notes |
| --- | --- | --- |
| [idb](https://github.com/facebook/idb)'s `idb.proto`, at v1.7.7 | MIT | `test/fixtures/proto/idb.proto`, unchanged, with its notice. The device server's codec is checked against its field numbers. |
| The Android emulator's `emulator_controller.proto`, from emulator 37.2.12.0 (`emulator-linux_x64-16428233.zip`, its SHA-1 as Google's repository manifest gives it) | Apache 2.0 | `test/fixtures/proto/emulator_controller.proto`, unchanged, with its notice. The same check. |

## On hosts

| Software | Licence | Where |
| --- | --- | --- |
| [microsandbox](https://github.com/superradcompany/microsandbox)'s `msb` | Apache 2.0 | The microsandbox backend installs it on its host. |

## Fetched into boxes

`box_record` fetches one of these into a box whose own ffmpeg cannot make a clip, at the box's first recording (099). The box downloads it from its publisher and checks it against a SHA-256 pinned in `src/core/record-ffmpeg.ts`. bb-box does not redistribute it.

| Software | Licence | For |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) 9.0.2, built by [BtbN's FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), release `autobuild-2026-09-30-13-08`, the `gpl` builds | GNU GPL 3.0, as built with x264 and other GPL libraries | Linux on x86_64 and arm64 |
| [FFmpeg](https://ffmpeg.org) 9.0.2, built by [Martin Riedl](https://ffmpeg.martin-riedl.de), release `1789931890_9.0.2` | GNU GPL 3.0, as built with x264 and other GPL libraries | macOS on arm64 |

## In box images

| Software | Licence | In |
| --- | --- | --- |
| [Selkies](https://github.com/selkies-project/selkies) | Mozilla Public License 2.0 | Linux desktops on X11, for video |
| [TigerVNC](https://github.com/TigerVNC/tigervnc) | GNU GPL 2.0 | Linux desktops on X11 |
| [VirtualGL](https://github.com/VirtualGL/virtualgl) | wxWindows Library Licence 3.1 | Linux desktops on a GPU |
| NVIDIA's driver | NVIDIA's licence | Linux desktops on an NVIDIA GPU, at the host's own driver version |
| Google Chrome | Google Chrome's terms of service | Linux desktops |
| [Cua Driver](https://github.com/trycua/cua) | MIT | Desktops, for computer use |
| [BlackHole](https://github.com/ExistentialAudio/BlackHole) 2ch | Its source is under the GNU GPL 3.0. The official installer, which the macOS image uses, is © Existential Audio Inc., and so are its name and branding. | macOS on Tart, as the microphone |
| [Node.js](https://github.com/nodejs/node), [GitHub CLI](https://github.com/cli/cli) | MIT | All images |
| [Codex](https://github.com/openai/codex) | Apache 2.0 | All images |
| [Pi](https://github.com/earendil-works/pi) | MIT | All images |
| Claude Code | © Anthropic PBC, under Anthropic's terms; not open source | All images |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | MIT or the Unlicense | Linux |
| [fd](https://github.com/sharkdp/fd), [uv](https://github.com/astral-sh/uv) | MIT or Apache 2.0 | Linux |
| [jj](https://github.com/jj-vcs/jj) | Apache 2.0 | Linux |
| [rustup](https://github.com/rust-lang/rustup) | MIT or Apache 2.0 | Linux desktops, Windows |
| [PowerShell](https://github.com/PowerShell/PowerShell) 7 | MIT | Windows |
| [Git for Windows](https://github.com/git-for-windows/git) | GNU GPL 2.0 | Windows |
| [LLVM](https://github.com/llvm/llvm-project) | Apache 2.0 with LLVM exceptions | Windows |
| Visual Studio Build Tools | Microsoft's licence terms | Windows |

The other software in a Linux image comes from Ubuntu's archive. Each package's licence is in `/usr/share/doc/<package>/copyright` in the image.

A Windows image is built from your own Windows ISO, under your Windows licence. A macOS image starts from Cirrus Labs' Tart images of macOS and Xcode, under Apple's licences.

The exact versions are pinned in `setup/proxmox-lxc/template/pins.json`, `setup/proxmox-lxc/template/desktop-pins.tsv`, `setup/windows/pins.json` and the Tart image scripts.
