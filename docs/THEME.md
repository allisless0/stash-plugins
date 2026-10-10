# Flexoki theme for the Stash plugins (from Insights 2.0.0)

Every plugin in this repo uses this theme (since Insights 2.0.0 and the 2026-10-10
restyle of the rest). Reference implementation: `plugins/Insights/Insights.js`,
function `injectStyles()`. A new plugin or panel follows this file; see
MAINTENANCE.md §4.15.

## Palette (Flexoki dark, by Steph Ango)

Base layers, darkest to lightest:
- `--bg`  #100F0F  (page / panel base)
- `--bg2` #1C1B1A  (sunk wells, inputs, tracks)
- `--ui`  #282726  (raised card / panel surface)
- `--ui2` #343331  (hover, selected, buttons)
- `--ui3` #403E3C  (borders, lit top edges)

Text:
- `--tx3` #575653 (faint), `--tx2b` #6F6E69, `--tx2` #878580 (muted), `--tx1b` #B7B5AC, `--tx` #CECDC3 (body), `--hi` #E6E4D9 (headings, values)

Accents (dark-mode 400 values):
- red #D14D41, orange #DA702C, yellow #D0A215, green #879A39, cyan #3AA99F, blue #4385BE, purple #8B7EC8, magenta #CE5D97
- Darker 600 values when you need a pressed/darker shade: red #AF3029, orange #BC5215, yellow #AD8301, green #66800B, cyan #24837B, blue #205EA6, purple #5E409D, magenta #A02F6F
- Lighter text-on-dark variants used in Insights: up/positive #A9BA5A, down/negative #E8705F, link hover #6FA3D6
- Text on a filled accent background: #100F0F

Semantic mapping (keep meaning, change hue to Flexoki):
- success / connected / done / positive -> green #879A39 (text #A9BA5A)
- danger / delete / error / stop -> red #D14D41 (text #E8705F)
- warning / pending -> yellow #D0A215
- info / links -> blue #4385BE (hover #6FA3D6)
- O's / drops / "intimate" highlights -> magenta #CE5D97
- watch time / play -> cyan #3AA99F

## Depth (the user asked for "more depth")

Raised surfaces (cards, panels, dialogs, popovers, menus):
```css
background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
border: 1px solid #0d0c0c; border-top-color: #48463F;
border-radius: 12px;
box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65);
```
Floating overlays (modals, popover panels) add a bigger shadow: `0 20px 50px -12px rgba(0,0,0,.75)`.

Sunk wells (inputs, search boxes, progress tracks, segmented-control strips, list backgrounds):
```css
background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331;
box-shadow: inset 0 2px 5px rgba(0,0,0,.5);
```
Bars/fills inside tracks: `box-shadow: inset 0 1px 0 rgba(255,255,255,.2)`.

Buttons:
```css
background: linear-gradient(180deg, #343331, #282726); color: #CECDC3;
border: 1px solid #0b0a0a; border-top-color: #403E3C; border-radius: 8px;
box-shadow: 0 1px 2px rgba(0,0,0,.5);
/* hover: color #E6E4D9; border-top-color #575653 */
```
Primary/accent button: background the accent (or a gradient from the accent to its 600 shade), text #100F0F, same border/shadow recipe.

Selected chip / active tab (tinted with its accent `--c`):
```css
background: color-mix(in srgb, var(--c) 22%, #343331);
border-color: color-mix(in srgb, var(--c) 50%, transparent);
box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
color: #E6E4D9;
```
(Put a plain `background: #343331;` line before it as a fallback.)

Icon badges: 28px rounded square, `color: var(--c)`, `background: color-mix(in srgb, var(--c) 17%, #282726)`, `border: 1px solid color-mix(in srgb, var(--c) 30%, transparent)`.

Tooltips: `background:#1C1B1A; border:1px solid #403E3C; color:#E6E4D9; border-radius:8px; box-shadow:0 10px 28px rgba(0,0,0,.6)`.

Scrollbars: `scrollbar-color: #403E3C transparent`.

## Rules

- Restyle only. Do not change layout, behaviour, DOM structure, event handling, timing or logic. Class names stay. If a colour lives in JS (inline styles, canvas, SVG fills, computed colours), change the value only.
- Our own panels, dialogs, popovers, menus, toasts and overlays get the full treatment (Flexoki surfaces + depth).
- Things that sit inline inside Stash's own UI (a button in Stash's navbar, a badge on Stash's scene cards, a tab strip on Stash's studio page) must still look at home next to Stash: use Flexoki accent colours and the button/chip recipe, but do not paint large dark Flexoki slabs over Stash's page.
- Keep contrast readable: body text #CECDC3 on #282726; muted #878580 only for secondary text.
- Plain comments explaining why, no emoji in code. Keep each file's existing formatting style.
- Do not use any colour outside the palette above (plus transparent blacks/whites for shadows and highlights).
