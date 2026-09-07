FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable pnpm
# Manifests first so dependency installation caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/store-sqlite/package.json packages/store-sqlite/
COPY packages/store-contract/package.json packages/store-contract/
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps/relay ./apps/relay
RUN pnpm build
# A self-contained production tree for the application: its dist, its dependencies, and
# the built workspace packages copied in as real modules.
RUN pnpm --filter @endclose/relay-app deploy --legacy --prod /out/app

FROM node:22-slim
# vim-tiny (~2 MB) provides `vi` for `relayctl config edit`. The base image ships no
# editor, and in production the root filesystem is read-only, so one has to be baked in.
# It edits a temp file under /tmp (tmpfs), which stays writable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends vim-tiny \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r relay && useradd -r -g relay relay \
    && mkdir -p /var/lib/endclose-relay /etc/endclose-relay \
    && chown relay:relay /var/lib/endclose-relay
WORKDIR /app
# The product version (read by the application at boot) lives in the root manifest.
COPY --from=build /src/package.json ./package.json
COPY --from=build /out/app ./app
# In-container operator CLI (ECS Exec / docker exec). Uses ADMIN_BASIC_AUTH from env.
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/app/dist/cli/relayctl.js "$@"' > /usr/local/bin/relayctl \
    && chmod 755 /usr/local/bin/relayctl
USER relay
ENV NODE_ENV=production RELAY_CONFIG=/etc/endclose-relay/relay.yaml EDITOR=vi
EXPOSE 8443
CMD ["node", "app/dist/index.js"]
