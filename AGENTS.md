# Workflow

- Work only on `main`; do not create branches or PRs.
- Before every push: typecheck, tests, and production build.
- Push directly to `main`; CI/CD is the only production deploy path.
- Server access is read-only diagnostics or explicitly requested testing—never copy code, build, or deploy manually.
