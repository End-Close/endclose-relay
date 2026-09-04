FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/store-sqlite/package.json packages/store-sqlite/
COPY packages/store-contract/package.json packages/store-contract/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.base.json vite.config.ts ./
COPY packages ./packages
COPY src ./src
COPY ui ./ui
RUN pnpm build
RUN CI=true pnpm prune --prod

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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Workspace packages (@endclose/relay, @endclose/relay-sqlite) are symlinked from node_modules.
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/store-sqlite/package.json ./packages/store-sqlite/
COPY --from=build /app/packages/store-sqlite/dist ./packages/store-sqlite/dist
COPY --from=build /app/packages/store-sqlite/node_modules ./packages/store-sqlite/node_modules
# In-container operator CLI (ECS Exec / docker exec). Uses ADMIN_BASIC_AUTH from env.
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/cli/relayctl.js "$@"' > /usr/local/bin/relayctl \
    && chmod 755 /usr/local/bin/relayctl
USER relay
ENV NODE_ENV=production RELAY_CONFIG=/etc/endclose-relay/relay.yaml EDITOR=vi
EXPOSE 8443
CMD ["node", "dist/index.js"]
