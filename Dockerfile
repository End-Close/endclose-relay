FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY ui ./ui
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-slim
RUN groupadd -r relay && useradd -r -g relay relay \
    && mkdir -p /var/lib/endclose-relay /etc/endclose-relay \
    && chown relay:relay /var/lib/endclose-relay
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER relay
ENV NODE_ENV=production RELAY_CONFIG=/etc/endclose-relay/relay.yaml
EXPOSE 8443
CMD ["node", "dist/index.js"]
