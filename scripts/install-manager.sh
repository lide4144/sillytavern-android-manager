#!/usr/bin/env bash
# Install only the manager service; never imports accounts or replaces gateway keys.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run inside the Linux container as root.' >&2; exit 1; }
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
ROOT=${GATEWAY_ROOT:-/opt/st-subscription-proxy}
TAVERN_ROOT=${TAVERN_ROOT:-/opt/SillyTavern}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -x "$NODE_BIN" ] || { echo 'Set NODE_BIN to Node.js 24 or later.' >&2; exit 1; }
for value in "$ROOT" "$TAVERN_ROOT" "$NODE_BIN"; do
 case "$value" in *[!a-zA-Z0-9_./-]*|'') echo 'Deployment paths must be simple absolute paths without whitespace.' >&2; exit 1;; esac
 case "$value" in /*) ;; *) echo 'Deployment paths must be absolute.' >&2; exit 1;; esac
done
[ -f "$ROOT/local-access.json" ] || { echo 'Prepare private local-access.json matching your gateway configuration first.' >&2; exit 1; }
[ -x "$ROOT/cli-proxy-api" ] || { echo 'Install a compatible CLIProxyAPI binary first.' >&2; exit 1; }
[ -f "$TAVERN_ROOT/data/default-user/settings.json" ] || { echo 'Start SillyTavern once to create default-user settings; see README for other users.' >&2; exit 1; }
export CHECK_ACCESS="$ROOT/local-access.json"
"$NODE_BIN" --input-type=module - <<'JS'
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CHECK_ACCESS,'utf8'));
for(const k of ['apiKey','managementKey'])if(typeof c[k]!=='string'||c[k].length<16||c[k].includes('REPLACE_'))throw Error('Set private '+k+' to your actual configured gateway key.');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js >=24 is required.');
console.log('Gateway key-file structure checked; values not printed.');
JS
umask 077
DEST="$ROOT/manager"
if [ -d "$DEST/public" ]; then
 mkdir -p "$ROOT/manager-code-backups"
 tar -czf "$ROOT/manager-code-backups/code-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$DEST" server.mjs public
fi
mkdir -p "$DEST/public"
cp "$SOURCE/manager/server.mjs" "$SOURCE/manager/device-login.mjs" "$DEST/"
cp "$SOURCE/manager/public/index.html" "$SOURCE/manager/public/app.js" "$SOURCE/manager/public/style.css" "$DEST/public/"
"$NODE_BIN" --check "$DEST/server.mjs"
if [ ! -f "$DEST/manager-access.json" ]; then
 "$NODE_BIN" --input-type=module - "$DEST/manager-access.json" <<'JS'
import fs from 'node:fs';import crypto from 'node:crypto';
fs.writeFileSync(process.argv[2],JSON.stringify({baseUrl:'http://127.0.0.1:8318/',appKey:crypto.randomBytes(32).toString('hex')},null,2),{mode:0o600});
console.log('Created private app configuration; secret not printed.');
JS
fi
chmod 700 "$DEST"
chmod 600 "$ROOT/local-access.json" "$DEST/manager-access.json"
cat > /etc/systemd/system/st-subscription-manager.service <<UNIT
[Unit]
Description=Phone-local subscription manager
After=network.target st-subscription-proxy.service
Wants=st-subscription-proxy.service
[Service]
Type=simple
WorkingDirectory=$DEST
Environment=ST_MANAGER_ROOT=$ROOT
Environment=ST_MANAGER_DATA_DIR=$DEST
Environment=ST_MANAGER_SETTINGS_PATH=$TAVERN_ROOT/data/default-user/settings.json
ExecStart=$NODE_BIN $DEST/server.mjs
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now st-subscription-manager.service
systemctl restart st-subscription-manager.service
printf 'Installed manager. Provision its private app config using scripts/provision-android.sh inside Android root shell.\n'
