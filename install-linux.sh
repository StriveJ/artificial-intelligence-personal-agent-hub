#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  printf 'Usage: sh install-linux.sh <absolute-instance-path> [tailscale-hostname] [claude|codex]\n' >&2
  exit 1
fi
app_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
instance=$(CDPATH='' cd -- "$1" && pwd -P)
hostname=${2:-}
engine=${3:-claude}
service_user=$(id -un)
service_group=$(id -gn)
runtime_dir="$HOME/.local/state/aipa-hub"
node_bin=$(command -v node)
case "$engine" in claude|codex) ;; *) printf 'Engine must be claude or codex\n' >&2; exit 1 ;; esac
test -f "$instance/AIPA-MANIFEST.yaml"
command -v "$engine" >/dev/null
"$node_bin" --input-type=module - "$app_dir" "$instance" "$runtime_dir" "$hostname" "$engine" <<'JS'
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const [app, root, runtimeDir, hostname, engine] = process.argv.slice(2);
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
for (const path of [app, root, runtimeDir]) if (/[\r\n"%]/.test(path)) throw new Error('Path contains characters unsupported by systemd configuration');
if (hostname && !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname)) throw new Error('This device .ts.net domain is required');
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const path = join(runtimeDir, 'config.json');
let previous = {};
if (existsSync(path)) {
  previous = JSON.parse(readFileSync(path, 'utf8'));
  if (previous.root !== root) throw new Error('Existing service is bound to another instance; review configuration first');
  copyFileSync(path, join(runtimeDir, 'config.previous.json'));
}
writeFileSync(path, JSON.stringify({ ...previous, root, runtimeDir, hostname, engine, port: 4317 }, null, 2) + '\n', { mode: 0o600 });
JS

unit=/etc/systemd/system/aipa-hub.service
if [ -e "$unit" ] && ! grep -q '^# Managed by AIPA Hub install-linux.sh$' "$unit"; then
  printf 'aipa-hub.service exists from another source; overwrite refused. Review it first.\n' >&2
  exit 1
fi
unit_temp=$(mktemp)
trap 'rm -f -- "$unit_temp"' EXIT HUP INT TERM
cat > "$unit_temp" <<EOF
# Managed by AIPA Hub install-linux.sh
[Unit]
Description=AIPA Hub personal web host
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=simple
User=$service_user
Group=$service_group
WorkingDirectory=$app_dir
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:$(dirname -- "$node_bin"):/usr/local/bin:/usr/bin:/bin"
Environment=TZ=Asia/Shanghai
EnvironmentFile=-$runtime_dir/engine.env
ExecStart="$node_bin" "$app_dir/server.mjs" --config "$runtime_dir/config.json"
Restart=on-failure
RestartSec=5
TimeoutStopSec=420
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 0644 "$unit_temp" "$unit"
sudo systemctl daemon-reload
sudo systemctl enable aipa-hub.service
sudo systemctl restart aipa-hub.service
printf 'Hub service installed: systemctl status aipa-hub; logs: journalctl -u aipa-hub\n'
