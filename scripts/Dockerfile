# Uses Debian bullseye for GCC 10 / GLIBCXX compatibility with Move device.
# Bullseye is EOL: deb.debian.org no longer serves it and the security repo's
# signed Release file has expired, so a plain apt-get update fails outright.
# archive.debian.org keeps EOL releases available indefinitely, but main only
# -- it 404s the security repo, which apt (correctly) treats as a hard error
# for a repo listed in sources.list, so that line is dropped rather than
# repointed. Not needed here: this image only ever installs the
# cross-compiler toolchain, never security-patched packages, and is rebuilt
# fresh on every CI run rather than kept running.
FROM debian:bullseye-slim

RUN sed -i -e '/security/d' -e 's/deb.debian.org/archive.debian.org/g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    make \
    && rm -rf /var/lib/apt/lists/*

ENV CROSS_PREFIX=aarch64-linux-gnu-

WORKDIR /build
