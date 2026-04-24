FROM oven/bun:latest AS builder
WORKDIR /app
COPY cli/ .
RUN bun install --frozen-lockfile
RUN node scripts/build-binary.mjs --all
RUN VERSION=$(node -e "console.log(require('./package.json').version)") \
    && mkdir -p /dist/v${VERSION} \
    && cp dist/gate-dex-* /dist/v${VERSION}/ \
    && chmod +x /dist/v${VERSION}/gate-dex-*

FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /dist/ /usr/share/nginx/html/
EXPOSE 80
