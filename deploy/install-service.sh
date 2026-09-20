#!/usr/bin/env bash
# Install the user service. Run as your normal user; refuses to run as root.
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "refusing to run as root: this is a --user service" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT="claude-mcp-orchestrator.service"

if [[ ! -f "${REPO}/dist/index.js" ]]; then
  echo "dist/index.js is missing. Run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "${UNIT_DIR}"
sed "s|%h/code/claude-mcp-orchestrator|${REPO}|g" "${REPO}/deploy/${UNIT}" > "${UNIT_DIR}/${UNIT}"

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT}"

echo
systemctl --user status "${UNIT}" --no-pager || true
echo
echo "Installed ${UNIT_DIR}/${UNIT}"
echo "Logs:  journalctl --user -u ${UNIT} -f"
echo "Stop:  systemctl --user stop ${UNIT}"
echo
echo "To keep it running while logged out:  loginctl enable-linger ${USER}"
