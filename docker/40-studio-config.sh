#!/bin/sh
# Writes config.js (window.__STUDIO_CONFIG__) from the container environment at start-up.
# Unset or empty variables fall back to the defaults compiled into the app.
#
#   STUDIO_COMPUTE_URL      hosted compute base URL, e.g. https://compute.example.org ("" = same origin)
#   STUDIO_MATERIALS_URL    materials-db base URL ("" = bundled library only)
#   STUDIO_DEFAULT_SERVER   hosted | local | mock (default: hosted if STUDIO_COMPUTE_URL is set)
#   STUDIO_LOCAL_COMPUTE_URL  default http://localhost:8200
#   STUDIO_AUTH_MODE        none | oidc | community (default: oidc if STUDIO_OIDC_ISSUER is set,
#                           community if STUDIO_COMMUNITY_URL is set, else none)
#   STUDIO_OIDC_ISSUER, STUDIO_OIDC_CLIENT_ID, STUDIO_OIDC_SCOPE, STUDIO_OIDC_AUDIENCE
#   STUDIO_COMMUNITY_URL    Community app base URL for the token handoff
set -eu

out=/usr/share/nginx/html/config.js

# JSON string body: drop control characters, escape backslashes and quotes.
j() { printf '%s' "${1:-}" | tr -d '[:cntrl:]' | sed -e 's/[\\"]/\\&/g'; }

mode="${STUDIO_AUTH_MODE:-}"
if [ -z "$mode" ]; then
  if [ -n "${STUDIO_OIDC_ISSUER:-}" ]; then mode=oidc
  elif [ -n "${STUDIO_COMMUNITY_URL:-}" ]; then mode=community
  else mode=none
  fi
fi
case "$mode" in none|oidc|community) ;; *) echo "40-studio-config: invalid STUDIO_AUTH_MODE '$mode'" >&2; exit 1 ;; esac
case "${STUDIO_DEFAULT_SERVER:-}" in ""|hosted|local|mock) ;; *) echo "40-studio-config: invalid STUDIO_DEFAULT_SERVER" >&2; exit 1 ;; esac

cat > "$out" <<EOF
// Generated at container start by 40-studio-config.sh. Do not edit inside the container.
window.__STUDIO_CONFIG__ = {
  "defaultServer": "$(j "${STUDIO_DEFAULT_SERVER:-}")",
  "computeUrl": "$(j "${STUDIO_COMPUTE_URL:-}")",
  "localComputeUrl": "$(j "${STUDIO_LOCAL_COMPUTE_URL:-}")",
  "materialsUrl": "$(j "${STUDIO_MATERIALS_URL:-}")",
  "auth": {
    "mode": "$mode",
    "communityUrl": "$(j "${STUDIO_COMMUNITY_URL:-}")",
    "oidc": {
      "issuer": "$(j "${STUDIO_OIDC_ISSUER:-}")",
      "clientId": "$(j "${STUDIO_OIDC_CLIENT_ID:-}")",
      "scope": "$(j "${STUDIO_OIDC_SCOPE:-openid profile}")",
      "audience": "$(j "${STUDIO_OIDC_AUDIENCE:-}")"
    }
  }
};
EOF
echo "40-studio-config: wrote $out (auth: $mode)"
