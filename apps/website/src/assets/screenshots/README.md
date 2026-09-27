# Screenshots

Drop a screenshot here named after its slot and it replaces that slot's CSS
mockup on every language version of the site (PNG, JPEG, WebP or AVIF; Astro
generates the responsive sizes at build):

| File name     | Where it shows                           |
| ------------- | ---------------------------------------- |
| `hero.*`      | Top of the page, next to the headline    |
| `grid.*`      | "A closer look" — grid & tabs            |
| `sftp.*`      | "A closer look" — Files panel            |
| `tunnels.*`   | "A closer look" — tunnels & jump hosts   |
| `broadcast.*` | "A closer look" — broadcast input        |

The alt text for each slot is translated in `src/i18n/*.ts`.
