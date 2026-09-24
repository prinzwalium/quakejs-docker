# Official Node.js LTS image (Debian bookworm). Using the official image means no
# third-party apt repository (e.g. NodeSource) is needed to get Node.js.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim

# nginx serves the web client and game assets, supervisor runs nginx + the game server
RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx supervisor && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /quakejs

# Everything the image needs is vendored in this repository, so the build does not
# depend on GitHub, the npm registry or content.quakejs.com:
#   include/quakejs/html          web client from begleysm/quakejs, pre-patched for
#                                 same-origin assets and ws/wss (see include/quakejs/UPSTREAM.md)
#   include/quakejs/node_modules  runtime dependency of the dedicated server (ws)
#   include/ioq3ded               dedicated server with the EULA prompt removed
#   include/assets                game content served by nginx at /assets
COPY ./include/quakejs/package.json ./include/quakejs/package-lock.json /quakejs/
COPY ./include/quakejs/node_modules/ /quakejs/node_modules/
COPY ./include/ioq3ded/ioq3ded.fixed.js /quakejs/build/ioq3ded.js
COPY ./include/quakejs/html/ /quakejs/html/

# Copy server configuration files
COPY server.cfg /quakejs/base/baseq3/
COPY server.cfg /quakejs/base/cpma/

# Link QuakeJS to the nginx web root
RUN rm -rf /var/www/html && ln -s /quakejs/html /var/www/html

# Copy game assets to the web root
COPY ./include/assets/ /quakejs/html/assets/

# Configure supervisord and nginx
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY nginx.conf /etc/nginx/sites-available/default

# Create a non-root user for running the QuakeJS server
RUN groupadd -r quakejs && useradd -r -g quakejs quakejs && \
    chown -R quakejs:quakejs /quakejs

EXPOSE 80 27960

# Start the supervisor daemon
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
