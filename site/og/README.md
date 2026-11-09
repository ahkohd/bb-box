# Share images

The picture a chat or a search shows when someone shares a link to the site, and the site's PNG icons.

| File | Size | Where it goes |
| --- | --- | --- |
| `../public/og.png` | 1200 by 630 | Every page's `og:image` and `twitter:image` |
| `github-social.png` | 1280 by 640 | The GitHub repository's social preview, uploaded by hand in its settings |
| `../public/apple-touch-icon.png` | 180 by 180 | A phone's home screen |
| `../public/favicon-32.png` | 32 by 32 | Browsers that do not show the SVG favicon |

`card.html` is the card. It uses the site's colours, Inter and a crop of `docs/media/box-panel.png`, so the picture is the real Box panel. `render.ts` opens it in headless Chromium at each size and draws the icons from the logo.

To make them again, from `site/` after `npm ci`:

```sh
CHROMIUM=/path/to/chromium npm run og
```

`CHROMIUM` defaults to `chromium` on the path. Look at `og.png` at full size and at 600 pixels wide, the width of a chat preview, before you commit it.
