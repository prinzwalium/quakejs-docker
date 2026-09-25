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

echo "admin state (bundled map paks are installed):"
state="$(curl -fsS -b "$JAR" "$BASE/admin/api/state")"
echo "$state" | head -c 300
echo
echo "$state" | grep -q '"q3wctf1"'
echo "$state" | grep -q '"mapInfo"'

echo "public server info:"
curl -fsS "$BASE/admin/api/public/server" | grep -q '"online":true'

echo "rcon via admin:"
curl -fsS -b "$JAR" -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"command":"sv_hostname"}' "$BASE/admin/api/console"
echo

echo "lobby:"
curl -fsS "$BASE/admin/api/public/lobby" | grep -q '"id":"sarge"'
curl -fsS -o /dev/null -w '%{content_type}\n' "$BASE/admin/api/public/icon/sarge/default.png" | grep -q image/png
curl -fsS "$BASE/lobby.js" | grep -q qjsLobby
curl -fsS "$BASE/lobby.js" | grep -q applyInEngine

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
curl -fsS "$BASE/admin/api/public/matches?bots=1" | grep -q '"matches":\['

echo "presets:"
presets="$(curl -fsS -b "$JAR" "$BASE/admin/api/presets")"
echo "$presets" | grep -q '"name":"Capture the flag"'
ctf="$(echo "$presets" | sed 's/.*"id":"\([a-f0-9]*\)","name":"Capture the flag".*/\1/')"
curl -fsS -b "$JAR" -X POST -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d "{\"id\":\"$ctf\",\"changeMap\":true}" "$BASE/admin/api/presets/apply" | grep -q '"gametype":4'
echo "waiting for the CTF map..."
for i in $(seq 1 20); do
  out="$(curl -fsS -b "$JAR" "$BASE/admin/api/status" || true)"
  case "$out" in
    *'"map":"q3wctf1"'*'"gametype":4'*) echo "$out"; break ;;
  esac
  sleep 3
done
case "$out" in
  *'"map":"q3wctf1"'*'"gametype":4'*) ;;
  *) echo "CTF preset did not load q3wctf1: $out"; exit 1 ;;
esac
curl -fsS -b "$JAR" -X POST -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"name":"Smoke preset"}' "$BASE/admin/api/presets" | grep -q '"name":"Smoke preset"'

echo "player roster:"
curl -fsS -b "$JAR" -X PUT -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"players":[{"name":"Smoke","aliases":["Tester"],"model":"sarge"}]}' "$BASE/admin/api/players" | grep -q '"name":"Smoke"'
curl -fsS "$BASE/admin/api/public/lobby" | grep -q '"name":"Smoke"'

echo "healthcheck:"
docker exec "$NAME" node /quakejs/admin/healthcheck.js

echo "bans:"
curl -fsS -b "$JAR" -X POST -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  -d '{"ip":"203.0.113.9","reason":"smoke","duration":3600}' "$BASE/admin/api/bans" | grep -q '"ip":"203.0.113.9"'
curl -fsS -b "$JAR" "$BASE/admin/api/bans" | grep -q '"reason":"smoke"'

echo "audit log:"
curl -fsS -b "$JAR" "$BASE/admin/api/audit" | grep -q '"action":"ban"'

echo "backup round trip:"
curl -fsS -b "$JAR" -o /tmp/qjs-backup.json "$BASE/admin/api/backup"
grep -q '"format": "quakejs-admin-backup"' /tmp/qjs-backup.json
grep -q '"name": "Smoke preset"' /tmp/qjs-backup.json
curl -fsS -b "$JAR" -X POST -H 'X-Requested-With: qjs-admin' -H 'Content-Type: application/json' \
  --data-binary @/tmp/qjs-backup.json "$BASE/admin/api/backup" | grep -q '"ok":true'
rm -f /tmp/qjs-backup.json

echo "container health status:"
docker inspect --format '{{.State.Health.Status}}' "$NAME"

echo "smoke test passed"
