# Icons

Glyphs the panel ships, declared in `package.json` under
`bb.branding.experimental_icons` and used as `<plugin id>/<name>`.

- `icon.svg`, `monitor.svg`, `server.svg`, `terminal.svg`, `laptop.svg`,
  `plug.svg`: bb-box's own, drawn in BB's stroke style. `icon.svg` is also
  declared as `box`, the Boxes page's sidebar icon.
- `proxmox.svg`, `docker.svg`: from [Simple Icons](https://simpleicons.org)
  (CC0 1.0), reduced to one path filled with the current colour. They mark
  which provider a kind of box comes from. The Proxmox and Docker names and
  logos are trademarks of their owners, used here only to refer to those
  products. Apple's logo is not used: Apple does not allow it in third-party
  products, so a Mac host shows the laptop glyph and the host's name.
