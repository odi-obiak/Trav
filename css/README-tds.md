# Travelers Design System on this page

- `tds.min.css` is copied unchanged from `@trv-tds/core` 8.8.1 (`dist/css/tds.min.css`, from the TDS Docsite v8-8-1 package).
  To upgrade, replace this file with the newer one from the same package.
- Fonts (Batterson Sans) load from `https://cdn.travelers.com/fonts/2.1/allfonts.min.css`, as on the TDS docsite. Without
  network access to that host, the page falls back to the system sans serif font.
- Icons are the TDS functional and logo sprites. Only the symbols this page uses are inlined at the top of `index.html`,
  so the page needs no extra requests.
- `page.css` adds only the layout and the parts TDS has no component for (call card, quote panel rows, upload button
  states). Its colors are TDS token values (`dist/tokens/tokens.json`), with the token name in each comment.
- TDS components used: Global Header, Tag, Card (clickable), Inline Alert, Field, Button (primary, secondary, tertiary,
  small) and Chat Message. Chat Message follows the TDS AI & Chat guidance: plain for AISA's replies, bubble for the customer.
- Not used: the TDS JavaScript. The one behavior needed from it (a click anywhere on a clickable card presses its button)
  is a few lines at the bottom of `index.html`.
