FROM node:22.23.1-bookworm@sha256:a25c9934ff6382cd4f08b6bc26c82bf4ea69b1e6f8dabfb2ead457374127c365

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /source
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/plugin-api/package.json packages/plugin-api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .

ENV HOME=/work/home \
    TMPDIR=/work/tmp
WORKDIR /work
CMD ["sh", "-c", "cp -R /source/. /work/ && mkdir -p /work/home /work/tmp && node scripts/terminal-stress/run.mjs"]
