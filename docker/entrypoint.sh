#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
STATE_DIR="${TEAMS_BRIDGE_STATE_DIR:-$HERMES_HOME/teams-bridge}"
CONFIG_SRC="${TEAMS_BRIDGE_CONFIG:-/app/config.json}"
TARGET_UID="${HERMES_UID:-$(stat -c '%u' "$HERMES_HOME")}"
TARGET_GID="${HERMES_GID:-$(stat -c '%g' "$HERMES_HOME")}"

if [ "$TARGET_UID" = "0" ]; then
	TARGET_UID=10000
	TARGET_GID=10000
fi

mkdir -p "$STATE_DIR"
cp -f "$CONFIG_SRC" "$STATE_DIR/config.json"

if [ "$(id -u)" != "0" ]; then
	cd "$STATE_DIR"
	exec node /app/dist/index.js
fi

if ! getent group "$TARGET_GID" >/dev/null 2>&1; then
	groupadd -g "$TARGET_GID" teams-bridge
fi
if ! getent passwd "$TARGET_UID" >/dev/null 2>&1; then
	useradd -u "$TARGET_UID" -g "$TARGET_GID" -M -d "$HERMES_HOME" -s /bin/sh teams-bridge
fi

chown -R "$TARGET_UID:$TARGET_GID" "$STATE_DIR"
mkdir -p /tmp/hermes-runtime
chown "$TARGET_UID:$TARGET_GID" /tmp/hermes-runtime
chmod 0700 /tmp/hermes-runtime

if command -v setpriv >/dev/null 2>&1; then
	exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --init-groups \
		env HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" \
		HERMES_WRITE_SAFE_ROOT="$HERMES_HOME" XDG_RUNTIME_DIR=/tmp/hermes-runtime \
		sh -c 'cd "$1" && exec node /app/dist/index.js' sh "$STATE_DIR"
fi

RUN_USER="$(getent passwd "$TARGET_UID" | cut -d: -f1)"
exec /command/s6-setuidgid "$RUN_USER" \
	env HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" \
	HERMES_WRITE_SAFE_ROOT="$HERMES_HOME" XDG_RUNTIME_DIR=/tmp/hermes-runtime \
	sh -c 'cd "$1" && exec node /app/dist/index.js' sh "$STATE_DIR"
