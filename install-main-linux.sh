#!/usr/bin/env bash
set -euo pipefail
config=${1:?Usage: install-main-linux.sh /absolute/config.json service-name}
name=${2:?An independent service name is required}
engine_env=${3:-}
environment_line=''
[[ "$config" = /* && "$name" =~ ^aipa-hub-main-[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid config path or service name' >&2; exit 1; }
[[ "$config" != *'"'* && "$config" != *'%'* && "$config" != *$'\n'* ]] || exit 1
if [[ -n "$engine_env" ]]; then [[ "$engine_env" = /* && -r "$engine_env" && "$engine_env" != *'"'* && "$engine_env" != *'%'* && ! "$engine_env" =~ [[:space:]] ]] || exit 1; fi
if [[ -n "$engine_env" ]]; then environment_line="EnvironmentFile=$engine_env"; fi
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node_bin=$(command -v node)
[[ "$here" != *'"'* && "$here" != *'%'* && ! "$here" =~ [[:space:]] && "$node_bin" != *'"'* ]] || exit 1
"$node_bin" -e 'const fs=require("fs"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!c.root||!c.runtimeDir||!fs.existsSync(c.root+"/AIPA-MANIFEST.yaml"))process.exit(1)' "$config"
mkdir -p "$HOME/.config/systemd/user"
umask 077
unit="$HOME/.config/systemd/user/$name.service"
[[ ! -e "$unit" ]] || { echo 'Service exists; inspect it before reinstalling' >&2; exit 1; }
cat > "$unit" <<EOF
[Unit]
Description=AIPA Hub isolated main
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
$environment_line
WorkingDirectory=$here
ExecStart="$node_bin" "$here/main-server.mjs" --config "$config"
Restart=on-failure
RestartSec=10
TimeoutStopSec=420
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$name.service"
systemctl --user is-active "$name.service"
