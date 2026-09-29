# Disposable network-none qualification tools, not a browser or production Host image.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node
FROM debian:forky-slim@sha256:61c8340200f7d4e440dd0c52ac81628060da77410108afaebb23d38e43f39fa1
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
COPY egress-fixture.sources /etc/apt/sources.list.d/debian.sources
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 755 /usr/sbin/policy-rc.d \
    && apt-get -o APT::Update::Error-Mode=any update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       squid=7.7-1 squid-common=7.7-1 iproute2=7.1.0-1 systemd-standalone-tmpfiles=261.2-1 \
    && mkdir -p /usr/local/share/openbot-egress-fixture \
    && sha256sum /var/lib/apt/lists/*InRelease > /usr/local/share/openbot-egress-fixture/apt-inrelease.sha256 \
    && dpkg-query -W > /usr/local/share/openbot-egress-fixture/packages.txt \
    && sha256sum /usr/sbin/squid > /usr/local/share/openbot-egress-fixture/binary.sha256 \
    && rm -rf /var/lib/apt/lists/*
