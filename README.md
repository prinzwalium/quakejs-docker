<div align="center">

![logo](https://github.com/PrinzWalium/quakejs-docker/blob/master/quakejs-docker.png?raw=true)
# quakejs-docker

![Docker Image CI](https://github.com/PrinzWalium/quakejs-docker/workflows/Docker%20Image%20CI/badge.svg)

</div>

### A fully local and Dockerized quakejs server. Independent, unadulterated, and free from the middleman.

The goal of this project was to create a fully independent quakejs server in Docker that does not require content to be served from the internet.
Hence, once pulled, this does not need to connect to any external provider, ie. content.quakejs.com. Nor does this server need to be proxied/served/relayed from quakejs.com

#### Simply pull the image [prinzwalium/quakejs](https://hub.docker.com/r/prinzwalium/quakejs)

```
docker pull prinzwalium/quakejs:latest
```

#### and run it:

```
docker run -d --name quakejs -p 8080:80 prinzwalium/quakejs:latest
```

#### Example:

```
docker run -d --name quakejs -p 8080:80 prinzwalium/quakejs:latest
```

Send all you friends/coworkers the link: ex. http://localhost:8080 and start fragging ;)

#### server.cfg:

Refer to [quake3world](https://www.quake3world.com/q3guide/servers.html) for instructions on its usage.

#### docker-compose.yml

```
services:
    quakejs:
        container_name: quakejs
        ports:
            - '8080:80'
        image: 'prinzwalium/quakejs:latest'
        restart: unless-stopped
```

#### HTTPS / reverse proxy

The web client loads `manifest.json`, the game assets and the game websocket from the same host and
protocol the page was opened with (`ws://` on http, `wss://` on https). Point your reverse proxy at
port 80 of the container and make sure it forwards websocket upgrades.

#### Building the Image

Build the image with:

`docker build . -t prinzwalium/quakejs:latest`

Everything the image needs is vendored in this repository, so a build does not depend on
third-party sources that may disappear (GitHub repositories, the npm registry, content.quakejs.com).
Only the official `node` base image and the Debian packages `nginx` and `supervisor` are downloaded.

| Path | Contents |
| --- | --- |
| `include/assets/` | Game content (demo/point-release installers, pk3 files, `manifest.json`), served by nginx at `/assets` |
| `include/ioq3ded/` | QuakeJS dedicated server, with the interactive EULA prompt removed |
| `include/quakejs/html/` | QuakeJS web client from [begleysm/quakejs](https://github.com/begleysm/quakejs), pre-patched for reverse proxies, see [UPSTREAM.md](include/quakejs/UPSTREAM.md) |
| `include/quakejs/node_modules/` | `ws`, the only runtime dependency of the dedicated server |

The dedicated server is started with `+set fs_cdn 127.0.0.1:80`, so it loads its content from the
container's own nginx instead of content.quakejs.com.

To keep a copy of a known-good image that does not depend on Docker Hub:

```
docker save prinzwalium/quakejs:latest | gzip > quakejs-image.tar.gz
docker load < quakejs-image.tar.gz
```

## Credits:

Thanks to [begleysm](https://github.com/begleysm) with his [fork](https://github.com/begleysm/quakejs) of [quakejs](https://github.com/inolen/quakejs) to which this was derived, aswell as his thorough [documentation](https://steamforge.net/wiki/index.php/How_to_setup_a_local_QuakeJS_server_under_Debian_9_or_Debian_10)
And of course thanks to [treyyoder](https://github.com/treyyoder) for his work on the [container](https://github.com/treyyoder/quakejs-docker)!