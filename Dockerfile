FROM node:24.13.0-bookworm-slim

ARG S3_PUBLIC_ENDPOINT=http://localhost:9000

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV S3_PUBLIC_ENDPOINT=$S3_PUBLIC_ENDPOINT

RUN corepack enable \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /home/node/.local/share/pnpm \
    && chown -R node:node /app /home/node/.local/share/pnpm

WORKDIR /app
COPY --chown=node:node . .
USER node
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build

CMD ["corepack", "pnpm", "--filter", "@slopproof/web", "exec", "next", "start", "--hostname", "0.0.0.0"]
