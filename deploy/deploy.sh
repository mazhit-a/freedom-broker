#!/usr/bin/env bash
# Runs on the server. Usage: echo $GHCR_TOKEN | GHCR_USER=x ./deploy.sh <image:tag>
# Rolls back to the previous image if the new one fails its health check.
set -euo pipefail
NEW="$1"
cd "$(dirname "$0")"
docker login ghcr.io -u "$GHCR_USER" --password-stdin
PREV="$(cat .current_image 2>/dev/null || true)"

healthy() {
  # No host port is published; use the container's own HEALTHCHECK status.
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' cqa 2>/dev/null)" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

CQA_IMAGE="$NEW" docker compose -f docker-compose.prod.yml pull
CQA_IMAGE="$NEW" docker compose -f docker-compose.prod.yml up -d
if healthy; then
  echo "$NEW" > .current_image
  docker image prune -f >/dev/null
  echo "Deployed $NEW"
else
  echo "Health check failed for $NEW" >&2
  if [ -n "$PREV" ]; then
    echo "Rolling back to $PREV" >&2
    CQA_IMAGE="$PREV" docker compose -f docker-compose.prod.yml up -d
  fi
  exit 1
fi
