# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM nousresearch/hermes-agent:v0.22.5

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json config.json ./
COPY docker/entrypoint.sh /usr/local/bin/teams-bridge-entrypoint
RUN chmod 0755 /usr/local/bin/teams-bridge-entrypoint

ENTRYPOINT ["/usr/local/bin/teams-bridge-entrypoint"]
