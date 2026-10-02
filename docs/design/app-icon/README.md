# App icon sources

English · [简体中文](README.zh-CN.md)

Vector sources for the desktop app icon, drawn from the approved
[AppIcon artboard](../desktop-ui-2026-10/AppIcon.dc.html) and the Round Bot head in
[`RobotAvatar`](../../../apps/web/src/components/RobotAvatar.tsx). The desktop package turns them into
the macOS, Windows and Linux icon sets (`npm run icons:generate --workspace @openbot/desktop`, C16).

| File | Used for | Drawing |
| --- | --- | --- |
| `app-icon.svg` | Every size above 32px | Light tile `#F5F5F2` with a `#E3E3E6` edge; Round head, green jaw `#91CF4B` |
| `app-icon-dark.svg` | Dark Dock and the splash fallback | Tile `#1D1D1F` with a `#2C2C2E` edge; the avatar system's dark edition (body `#E8EBDD`, eyes `#20251F`, jaw `#ADF16A`) |
| `app-icon-small.svg` | 32px and below | The micro drawing: larger eyes, heavier antenna and ball; a 1px edge at 32px |

## How they are built

All three use a 1024-unit square viewBox and contain only paths, circles and rectangles with
fill and stroke attributes, plus a `<title>` for assistive technology: no styles, text,
images or external references.

- The tile matches the artboard's 256px icon with 58px corners: radius 230 at 1024.
- The head is the 96-unit avatar drawing, scaled to 784 units (196 of 256) and centred, so it
  starts at 120.
- The antenna stem is 4 units wide (6 in the micro drawing). The ball radius is 4.3 (5.6 in the
  micro drawing).

The artboard's dark Dock specimen passes a colour where the avatar expects `dark`, so it falls
back to the light drawing. These sources use the dark edition the avatar system defines for dark
surfaces, so the head stays visible on a dark Dock.

No other product's logo or mascot is used.
