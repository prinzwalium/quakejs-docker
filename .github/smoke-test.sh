#!/bin/sh
# Starts the image and checks that nginx, the game server and the admin interface work.
# Usage: .github/smoke-test.sh <image>
set -eu

IMAGE="$1"
NAME="quakejs-smoke-$$"
PASSWORD="smoke-test-password-123"
BASE="http://127.0.0.1:18080"
JAR="$(mktemp)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs ----"
    docker logs "$NAME" 2>&1 | tail -n 100 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$JAR"
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$NAME" -p 18080:80 -e ADMIN_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null

echo "nginx config:"
docker exec "$NAME" nginx -t

echo "waiting for the web server..."
for i in $(seq 1 30); do
  curl -fsS -o /dev/null "$BASE/" && break
  sleep 2
done
curl -fsS -o /dev/null "$BASE/"
curl -fsS -o /dev/null "$BASE/assets/manifest.json"

echo "admin login:"
curl -fsS -c "$JAR" -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "$BASE/admin/api/login"
echo

echo "waiting for the game server (downloads its assets on first start)..."
for i in $(seq 1 60); do
  out="$(curl -fsS -b "$JAR" "$BASE/admin/api/status" || true)"
  case "$out" in
    *'"online":true'*) echo "$out"; break ;;
  esac
  sleep 3
done
case "$out" in
  *'"online":true'*) ;;
  *) echo "game server did not come online: $out"; exit 1 ;;
esac

echo "admin state:"
curl -fsS -b "$JAR" "$BASE/admin/api/state" | head -c 300
echo

echo "rcon via admin:"
curl -fsS -b "$JAR" -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"command":"sv_hostname"}' "$BASE/admin/api/console"
echo

echo "lobby:"
curl -fsS "$BASE/admin/api/public/lobby" | grep -q '"id":"sarge"'
curl -fsS -o /dev/null -w '%{content_type}\n' "$BASE/admin/api/public/icon/sarge/default.png" | grep -q image/png
curl -fsS "$BASE/lobby.js" | grep -q qjsLobby

echo "disconnect page (client POSTs to / after leaving the game):"
curl -fsS -X POST -d 'error=test' "$BASE/" | grep -q 'You were disconnected'

echo "statistics are private by default:"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/api/public/stats")"
[ "$code" = "404" ] || { echo "expected 404, got $code"; exit 1; }
curl -fsS -o /dev/null "$BASE/stats/"

echo "make statistics public:"
curl -fsS -b "$JAR" -X PUT -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"statsPublic":true}' "$BASE/admin/api/settings" | grep -q '"statsPublic":true'
curl -fsS "$BASE/admin/api/public/stats?bots=1" | grep -q '"players"'

echo "player roster:"
curl -fsS -b "$JAR" -X PUT -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"players":[{"name":"Smoke","aliases":["Tester"],"model":"sarge"}]}' "$BASE/admin/api/players" | grep -q '"name":"Smoke"'
curl -fsS "$BASE/admin/api/public/lobby" | grep -q '"name":"Smoke"'

echo "smoke test passed"
