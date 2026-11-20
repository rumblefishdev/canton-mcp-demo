FROM eclipse-temurin:21-jdk AS canton

RUN mkdir -p /opt/canton \
    && wget -qO /tmp/canton.tar.gz https://github.com/digital-asset/canton/releases/download/v3.7.4/canton-open-source-3.7.4.tar.gz \
    && echo '83da2e30a43334a2126bbdd5b1076ee7cec69584d34090886a4b2b19ab4557cc  /tmp/canton.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/canton.tar.gz --strip-components=1 -C /opt/canton \
    && rm /tmp/canton.tar.gz \
    && install -d -o 10001 -g 10001 /runtime
COPY canton-docker.conf /opt/canton/docker.conf

WORKDIR /runtime
USER 10001:10001
ENTRYPOINT ["sh", "-c", "rm -f canton_ports.json synchronizer_id && exec \"$@\"", "--"]
CMD ["/opt/canton/bin/canton", "daemon", "-c", "/opt/canton/examples/08-interactive-submission/interactive-submission.conf", "-c", "/opt/canton/docker.conf", "--bootstrap", "/opt/canton/examples/08-interactive-submission/bootstrap.canton"]

FROM node:22-bookworm-slim AS demo

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && mkdir .state .signer && chown node:node .state .signer
USER node
