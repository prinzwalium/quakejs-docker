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

#### Admin interface

The image includes a web interface at `/admin/` (e.g. http://localhost:8080/admin/) to manage the server:

- **Settings:** server name, message of the day, join password, max players, game type, frag/time/capture limits, friendly fire, quad factor, respawn times, bots (allowed, fill up to N players, skill)
- **Map rotation:** built from the maps the server actually has, in any order
- **Live control:** current map and players, change map, restart match, skip to the next map, add/kick bots, kick players, send a message to all players, a console for any other server command, and a game server restart

It is disabled unless you set `ADMIN_PASSWORD` (at least 12 characters):

```
docker run -d --name quakejs -p 8080:80 -e ADMIN_PASSWORD='a-long-random-password' -v ./data:/data prinzwalium/quakejs:latest
```

Settings are stored in `/data/settings.json`. Mount `/data` as a volume to keep them when the container is recreated.
The game server config (`server.cfg`, `settings.cfg`) is generated from these settings at every start, so a
`server.cfg` mounted into the container is overwritten; use the *Extra config* field for additional commands.

Security:

- Serve `/admin/` over HTTPS (e.g. behind your reverse proxy); the session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- Logins are rate-limited: 5 failed attempts from one IP lock that IP out for 15 minutes (behind a reverse proxy, all requests share the proxy's IP). Sessions expire after 2 hours of inactivity or 12 hours at most.
- The admin talks to the game server over rcon with a random password generated on first start (stored in `/data/rcon_password`). Set `RCON_PASSWORD` to choose one yourself, e.g. to use rcon from a game client.
- If you don't need the admin interface, leave `ADMIN_PASSWORD` unset; you can additionally block `/admin/` in your reverse proxy.

Changes are applied to the running server when you save. Max players, game type and "bots allowed" take effect when the next map loads.

#### docker-compose.yml

```
services:
    quakejs:
        container_name: quakejs
        ports:
            - '8080:80'
        image: 'prinzwalium/quakejs:latest'
        environment:
            ADMIN_PASSWORD: 'a-long-random-password'
        volumes:
            - ./data:/data
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
| `admin/` | Admin interface (Node.js, no dependencies) and the generator for the game server config |

The dedicated server is started with `+set fs_cdn 127.0.0.1:80`, so it loads its content from the
container's own nginx instead of content.quakejs.com.

To build and publish an image from any branch without touching `latest`, run the
**Manual Docker Image Build** workflow from the Actions tab and pick the branch. The image is pushed
as `prinzwalium/quakejs:<branch-name>` (with `/` replaced by `-`), or with the tag you enter.

To keep a copy of a known-good image that does not depend on Docker Hub:

```
docker save prinzwalium/quakejs:latest | gzip > quakejs-image.tar.gz
docker load < quakejs-image.tar.gz
```

## Credits:

Thanks to [begleysm](https://github.com/begleysm) with his [fork](https://github.com/begleysm/quakejs) of [quakejs](https://github.com/inolen/quakejs) to which this was derived, aswell as his thorough [documentation](https://steamforge.net/wiki/index.php/How_to_setup_a_local_QuakeJS_server_under_Debian_9_or_Debian_10)
And of course thanks to [treyyoder](https://github.com/treyyoder) for his work on the [container](https://github.com/treyyoder/quakejs-docker)!