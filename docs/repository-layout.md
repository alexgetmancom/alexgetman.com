# Repository Layout Plan

This document records the intended repository boundaries and what should stay at the top level.

## Current Layout

- `src/` - Astro pages, layouts, data helpers and site code.
- `public/` - static public assets, `.well-known` metadata and public agent-facing docs.
- `docs/` - public site, brand, design and AIO documentation.
- `scripts/` - local build/asset helpers.
- `deploy/` - site-facing deployment and Nginx notes.
- `feed/` - local feed/content fixtures used by the site.
- `bin/` - small project helper commands.
- `plans.md` - current public roadmap.
- `README.md` - project entry point.

Generated/local directories such as `dist/` and `node_modules/` are not part of the architecture.

## Current Decision

Keep this repository public and site-facing. It is the trust surface for the brand:

- site code;
- public roadmap;
- design specs;
- brand strategy;
- SEO/AIO files;
- GitHub Discussions context;
- public agent metadata.

Do not move the project into a cosmetic `code/` directory. Astro projects are clearest when `src/`, `public/`, `docs/`, `scripts/` and `deploy/` stay at the top level.

## What Does Not Belong Here

- production secrets;
- raw server inventories;
- database dumps;
- token-level posting operations;
- private recovery commands;
- social API implementation details;
- publishing queue internals.

Those belong in private repos:

- `alexgetman-posting` for publishing automation;
- `infra-agent` for server contracts and recovery notes.

## Possible Future Cleanup

1. If `feed/` is only generated output, move it out of the repo or document it as generated.
2. If `bin/` duplicates `scripts/`, merge it into `scripts/`.
3. Keep old plans under `docs/archive/`.
4. Keep all public strategy docs under `docs/`, not root.

These are low-priority cleanups. The current top-level shape is acceptable for an Astro site.
