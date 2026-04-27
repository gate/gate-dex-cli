FROM oven/bun:latest AS builder
WORKDIR /app
COPY cli/ .

ARG RUN_ENV
ARG WALLET_SERVICE_URL
ARG BW_SERVICE_URL
ARG MARKET_TOKEN_URL
ARG DATA_API_URL
ARG BIZ_WALLET_URL

RUN printf 'RUN_ENV=%s\nWALLET_SERVICE_URL=%s\nBW_SERVICE_URL=%s\nMARKET_TOKEN_URL=%s\nDATA_API_URL=%s\nBIZ_WALLET_URL=%s\n' \
    "$RUN_ENV" "$WALLET_SERVICE_URL" "$BW_SERVICE_URL" "$MARKET_TOKEN_URL" "$DATA_API_URL" "$BIZ_WALLET_URL" > /app/.env

RUN bun install --frozen-lockfile
RUN node scripts/build-binary.mjs --all --bake-env --env-file /app/.env
RUN VERSION=$(node -e "console.log(require('./package.json').version)") \
    && mkdir -p /dist/v${VERSION} \
    && cp dist/gate-dex-* /dist/v${VERSION}/ \
    && chmod +x /dist/v${VERSION}/gate-dex-*

FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /dist/ /usr/share/nginx/html/
EXPOSE 80
