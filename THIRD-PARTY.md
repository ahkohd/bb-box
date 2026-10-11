# Third-party software

bb-box's own code is in this repository. This page lists the software of others that it uses:

- what the plugin bundles
- what it installs on a host
- what its setup scripts put in box images

bb-box does not redistribute the software it installs on hosts or puts in images. Each piece is downloaded from its publisher when you set up a host or build an image, and most are checked against a SHA-256 pinned in this repository. Each is under its own licence, which applies to whoever builds the image.

## In the plugin

| Software | Licence | Notes |
| --- | --- | --- |
| [noVNC](https://github.com/novnc/noVNC) 1.7.0, from npm (`@novnc/novnc`) | Mozilla Public License 2.0; the pako code it includes is under the MIT licence | The desktop viewer, unchanged. Its source and licence texts are in `node_modules/@novnc/novnc` after `npm install`. The video viewer is bb-box's own code, which uses noVNC's keyboard handling. |
| [xterm.js](https://github.com/xtermjs/xterm.js) and its fit add-on (`@xterm/xterm`, `@xterm/addon-fit`) | MIT | The terminal. `src/app/xterm-css.ts` is a copy of xterm.js's stylesheet, with its notice. |
| `zod`, `undici`, `@radix-ui/react-slot` | MIT | |

React, Radix's menus and dialogs, and the other packages BB shares with plugins come from BB at runtime. bb-box does not bundle them. The licence texts of everything bundled are in its package in `node_modules` after `npm install`.

## On hosts

| Software | Licence | Where |
| --- | --- | --- |
| [microsandbox](https://github.com/superradcompany/microsandbox)'s `msb` | Apache 2.0 | The microsandbox backend installs it on its host. |

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
