FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv

FROM mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948

USER root

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_cache=/opt/npm-cache

COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git python3 python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/cloudx-base

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/plugin-api/package.json packages/plugin-api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --ignore-scripts \
    && npm cache verify

COPY services/asr /opt/cloudx-services/asr
COPY services/documentation-indexer /opt/cloudx-services/documentation-indexer

RUN UV_PROJECT_ENVIRONMENT=/opt/cloudx-asr \
      uv sync --project /opt/cloudx-services/asr --locked --extra dev --no-editable \
    && UV_PROJECT_ENVIRONMENT=/opt/cloudx-documentation \
      uv sync --project /opt/cloudx-services/documentation-indexer --locked --extra dev --no-editable

COPY containers/ci/run.mjs containers/ci/attestation.test.mjs /opt/cloudx-ci/

RUN groupadd --gid 10001 cloudx-ci-candidate \
    && useradd --no-create-home --uid 10001 --gid 10001 \
      --home-dir /work/home --shell /usr/sbin/nologin cloudx-ci-candidate \
    && install --directory --mode=0555 /results \
    && install --mode=000 /dev/null /results/results.json \
    && git config --system --add safe.directory /work/repository \
    && chmod 0555 /opt/cloudx-ci/run.mjs \
    && node --test /opt/cloudx-ci/attestation.test.mjs \
    && rm /opt/cloudx-ci/attestation.test.mjs

USER root
WORKDIR /work
ENV HOME=/work/home \
    TMPDIR=/work/tmp \
    npm_config_cache=/work/npm-cache

ENTRYPOINT ["node", "/opt/cloudx-ci/run.mjs"]
