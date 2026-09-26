#!/usr/bin/env bash
# Install the eigenwife puppet routes into an Open Swarm checkout. Idempotent.
#   packages/harem/openswarm/apply.sh [path/to/openswarm]   (default ~/dev/openswarm)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
osw="${1:-$HOME/dev/openswarm}"
dst="$osw/backend/apps/agents"
[ -d "$dst" ] || { echo "no Open Swarm at $osw"; exit 1; }
cp "$here/eigenwife_puppet.py" "$dst/eigenwife_puppet.py"
line="from backend.apps.agents import eigenwife_puppet  # noqa: F401,E402  eigenwife harem"
grep -qF "eigenwife_puppet" "$dst/agents.py" || printf '\n%s\n' "$line" >> "$dst/agents.py"
echo "puppet routes installed in $osw. restart the backend: OSW_PREWARM_CLI=0 bash $osw/backend/run.sh"
