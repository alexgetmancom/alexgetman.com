# Media Test Matrix

## Site Article Image Standard

- Primary article image format: `1:1`, target size `1200x1200`.
- If the pipeline can generate only one image variant, use the square image for site cards, post pages and social distribution.
- `16:9` / `1200x630` can be added later as a derived OpenGraph-only asset, but it is not the source article image format.

Active targets:

- Telegram
- Site RU
- Site EN
- Threads RU
- LinkedIn

Currently inactive/not selectable:

- Facebook
- Threads EN
- X

## Current Known Status

| Test | Format | Telegram | Site RU/EN | Threads RU | LinkedIn |
|---|---:|---:|---:|---:|---:|
| T01 | Text only | pass | pass | pass | pass |
| T02 | Text + picture | pass | pass | pass | pass |
| T03 | Text + pictures | pass | partial | pass | pass |
| T04 | Text + video | pass | unverified | pass | pass |
| T05 | Text + videos | pass | unverified | pass | partial: first video only |
| T06 | Pictures only | pass | unverified | pass | skipped: no EN text |
| T07 | Videos only | pass | unverified | pass | skipped: no EN text |
| T08 | Video + picture | pass | unverified | pass | partial: first video only |
| T09 | Videos + pictures | unverified | unverified | unverified | unverified |

Use `posting/capability_matrix.py` to store formal evidence in the runtime SQLite DB.
