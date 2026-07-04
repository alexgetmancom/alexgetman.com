# Content Media Guidelines

## Current Direction

The project is moving to a **vertical-first news format**.

Primary cover media should be optimized for mobile/social consumption while still supporting normal article pages and search indexing.

## Article Cover Contract

- Preferred cover aspect ratio: `9:16`.
- Preferred source size: `1080x1920`.
- Text should not be baked into the image.
- The same cover image should work for RU and EN.
- Site overlays localized title, category, time and short excerpt in HTML.
- If source material is horizontal, create a vertical composition instead of stretching:
  - blurred/darkened background from the same media;
  - original screenshot/video frame centered;
  - optional dark gradient for text overlay.
- If source material is vertical, use it directly with minimal crop.

## Language Rules

- Avoid Russian text inside generated images.
- Prefer no text inside images at all.
- If text is unavoidable, use short English/neutral UI text only.
- Localized title and summary belong in HTML/social post text, not in the image.

## Site Display Rules

- Homepage story cards use strict `9:16`.
- Card images use `object-fit: cover`.
- Cards without media use a dark branded placeholder by category.
- Long-term pipeline should validate/normalize media aspect ratio before publishing.
