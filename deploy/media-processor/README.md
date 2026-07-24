# Remote media processor

This directory is the complete, versioned source for an optional remote
`MEDIA_PROCESSOR_PROVIDER=remote_http` executor. The backend's `local` provider
does not contact this service and uses its own CPU ffmpeg recipe.

## Runtime contract

The remote image requires an Intel VAAPI render node and encodes video Stories
as H.264 through `h264_vaapi`. Configure the host compose environment with an
immutable image reference:

```dotenv
MEDIA_PROCESSOR_IMAGE=ghcr.io/<owner>/alexgetman-media-processor@sha256:<digest>
MEDIA_PROCESSOR_TOKEN=<random secret shared with the backend>
```

`compose.yml` deliberately has no `build:` directive. A production worker must
run the digest built by CI, never a hand-copied source tree. The compose file
also maps `/dev/dri/renderD128`; hosts without Intel VAAPI must select the
backend's explicit `local` provider instead of silently falling back.

## Deployment model

CI builds and publishes this image on every successful `main` revision. Image
activation is intentionally manual: a deployment target selects a tested digest,
pulls it, recreates only `media-processor`, probes `/health`, and restores the
previous digest if that probe fails. Target names, image repository, compose
path, service name, health URL, and deployment transport belong in deployment
configuration; none are tied to a particular account or VM name.

For a migration from a legacy hand-built process, the one-time
`DEPLOY_ALLOW_INITIAL_SEED=true` setting permits the first immutable deployment
without inventing a rollback revision. If it fails, it reports that fact and
does not claim to have rolled back. Remove the setting after the first healthy
image: every later deployment then has a genuine previous digest.

The initial host bootstrap installs the compose file, a private deployment
agent, and an outbound management tunnel. Afterwards the agent receives only
immutable digests. Do not edit files in the worker directory or run `docker
compose build` there: both create source drift from this directory.
