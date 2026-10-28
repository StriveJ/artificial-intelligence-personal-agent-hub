#!/usr/bin/env bash
set -euo pipefail
installation=${1:?Usage: install-managed-linux.sh /absolute/installation.json service-name [engine-env]}
name=${2:?Independent service name required}
engine_env=${3:-}
[[ "$installation" = /* && "$name" =~ ^aipa-hub-managed-[a-zA-Z0-9_-]+$ && ! "$installation" =~ [[:space:]\"%] ]] || exit 1
node_bin=$(command -v node)
launcher=$("$node_bin" -e 'const fs=require("fs"),p=require("path"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.join(c.base,"bootstrap/hub-launcher.mjs"))' "$installation")
[[ -f "$launcher" && ! "$launcher" =~ [[:space:]\"%] ]] || exit 1
[[ -z "$engine_env" || "$engine_env" = /* && -r "$engine_env" && ! "$engine_env" =~ [[:space:]\"%] ]] || exit 1
umask 077
mkdir -p "$HOME/.config/systemd/user"
unit="$HOME/.config/systemd/user/$name.service"
[[ ! -e "$unit" ]] || { echo 'Service exists; inspect before changing' >&2; exit 1; }
{
  printf '[Unit]\nDescription=AIPA Hub managed launcher\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n'
  printf 'Environment="PATH=%s/.local/bin:/usr/local/bin:/usr/bin:/bin"\n' "$HOME"
  if [[ -n "$engine_env" ]]; then printf 'EnvironmentFile=%s\n' "$engine_env"; fi
  printf 'ExecStart="%s" "%s" --installation "%s"\n' "$node_bin" "$launcher" "$installation"
  printf 'Restart=on-failure\nRestartSec=10\nTimeoutStopSec=infinity\nKillMode=process\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n'
} > "$unit"
systemctl --user daemon-reload
systemctl --user enable --now "$name.service"
systemctl --user is-active "$name.service"
