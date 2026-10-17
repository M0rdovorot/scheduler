# Build context is the repository root: docker build -f deploy/web.Dockerfile .
FROM node:24-alpine AS build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/frontend/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
