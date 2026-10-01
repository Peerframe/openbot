# OpenBot frameless avatar system — v2

[简体中文](README.zh-CN.md)

> Source artwork as delivered by the repository owner (v2). The app draws v3 from it: the adjustments (Relay width, micro rules, eight jaw colours) are specified in [DESIGN.md](../desktop-ui-2026-10/DESIGN.md#bot-avatars-v3).

This is original, editable vector artwork based on OpenBot's established robot identity and the previous design study. It is a design delivery; application components and the installed app have not been changed.

## Files and use

- `assets/openbot-{round,relay,scout}-{light,dark}.svg`: standard artwork for 32 CSS pixels and above.
- `assets/openbot-{round,relay,scout}-{light,dark}-micro.svg`: optical artwork for 16–24 CSS pixels. Wider eyes; the Round antenna stem is thicker. At intermediate sizes below 32 px, prefer the micro artwork.
- `assets/manifest.json`: filenames, palettes and usage ranges.
- `contact-sheet.svg`: shareable overview.

Every SVG has a transparent background and a `0 0 96 96` viewBox. The files contain named silhouette, accent and eye groups. There are no embedded bitmaps, fonts, filters, scripts, image-generation dependencies or remote resources. The root title and description support standalone accessibility. Give decorative images empty alt text when the adjacent name already labels the person or Bot. When inlining multiple files, remove the root title/description and label the containing component, or prefix their IDs to avoid duplicate IDs.

`light` and `dark` refer to the **surrounding interface**, not the color of the robot. Use dark charcoal artwork on white/light gray surfaces; use the warm ivory artwork on dark surfaces. Theme selection is explicit and should follow the actual host surface. Do not place an opaque disc or square behind the artwork. Keep the full viewBox to preserve optical spacing and avoid cropping antennae/ears. Maintain a generous independent interaction target.

The three characters are visual identities, not enforced job assignments. Keep task status in a separate indicator or label. Do not reinterpret accent color as permission, approval or progress. Legacy body/accessory combinations are not migrated by this design delivery.

## Design decisions

The color band is reduced and integrated into the head contour. A smaller antenna balances the dome. All three characters use upright capsule eyes; subtle position/angle variation provides expression. The headset is slightly narrower at the face to account for its lateral attachments. The cat ears have softened tips. Light and dark editions use identical geometry for a given character and optical size.

## Verification scope

Static SVG structure and local presentation links are checked. The browser preview includes white, gray and dark surfaces, 16/24/32/48/64/96 CSS pixel specimens and representative chat/list contexts. These checks are design-asset checks, not application integration or assistive-technology conformance claims.
