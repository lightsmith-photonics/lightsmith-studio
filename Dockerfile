# Lightsmith Studio, web mode: build the static app, serve it with unprivileged nginx.
# The compute / materials / sign-in URLs are injected at container start (docker/40-studio-config.sh),
# so one image serves any deployment. The Tauri desktop build is separate (see README).
#
#   docker build -t lightsmith-studio .
#   docker run --rm -p 8080:8080 -e STUDIO_COMPUTE_URL=https://compute.example.org lightsmith-studio

ARG NODE_IMAGE=node:22.12.0-alpine3.21
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27.3-alpine3.20

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NGINX_IMAGE}
LABEL org.opencontainers.image.title="Lightsmith Studio" \
      org.opencontainers.image.description="Set up, run and analyse photonics simulations (web mode)" \
      org.opencontainers.image.licenses="MIT"
# frame-ancestors for the CSP: who may embed Studio in an iframe (e.g. the Community site).
ENV STUDIO_FRAME_ANCESTORS="'self'"
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=0755 docker/40-studio-config.sh /docker-entrypoint.d/40-studio-config.sh
# The web root is owned by the unprivileged nginx user so the entrypoint can write config.js.
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
