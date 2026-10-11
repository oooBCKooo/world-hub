#!/usr/bin/env bash
# Explicit acceptance preparation on a disposable CI runner, never a Runtime action.
set -euo pipefail
work=$(mktemp -d /tmp/world-hub-isolation-image.XXXXXX)
registry="world-hub-ci-registry-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
trap 'docker rm -f "$registry" >/dev/null 2>&1 || true; rm -rf -- "$work"' EXIT
docker pull python:3.14.0-slim
base=$(docker image inspect python:3.14.0-slim --format '{{index .RepoDigests 0}}')
[[ "$base" =~ ^python@sha256:[0-9a-f]{64}$ ]]
docker run --rm "$base" python3 -c 'import sys; assert sys.version_info[:3] == (3,14,0)'
curl --fail --location --proto '=https' --tlsv1.2 \
  'https://files.pythonhosted.org/packages/fa/a8/5b41e0da817d64113292ab1f8247140aac61cbf6cfd085d6a0fa77f4984f/websockets-15.0.1-py3-none-any.whl' \
  --output "$work/websockets-15.0.1-py3-none-any.whl"
echo 'f7a866fbc1e97b5c617ee4116daaa09b722101d4a3c170c787450ba409f9736f  websockets-15.0.1-py3-none-any.whl' > "$work/wheel.sha256"
(cd "$work" && sha256sum -c wheel.sha256)
cat > "$work/Dockerfile" <<EOF
FROM $base
COPY websockets-15.0.1-py3-none-any.whl /tmp/
RUN python3 -m pip install --no-index --no-deps /tmp/websockets-15.0.1-py3-none-any.whl && rm /tmp/websockets-15.0.1-py3-none-any.whl
EOF
# A temporary loopback registry gives the fixture a real manifest RepoDigest.
docker run -d --name "$registry" -p 127.0.0.1::5000 registry:2
port=$(docker port "$registry" 5000/tcp | sed -n 's/^127\.0\.0\.1://p')
[[ "$port" =~ ^[0-9]+$ ]]
tag="localhost:$port/world-hub-python:acceptance"
docker build --network=none --tag "$tag" "$work"
docker push "$tag"
digest=$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')
[[ "$digest" =~ ^localhost:[0-9]+/world-hub-python@sha256:[0-9a-f]{64}$ ]]
docker pull "$digest"
docker run --rm "$digest" python3 -c 'import sys,websockets; assert sys.version_info[:3] == (3,14,0); assert websockets.__version__ == "15.0.1"'
echo "WORLD_HUB_TEST_PYTHON_IMAGE=$digest" >> "$GITHUB_ENV"
echo "WORLD_HUB_TEST_PYTHON=$(command -v python)" >> "$GITHUB_ENV"
echo "WORLD_HUB_TEST_USER_UID=$(id -u)" >> "$GITHUB_ENV"
echo "WORLD_HUB_TEST_USER_GID=$(id -g)" >> "$GITHUB_ENV"
echo "Pinned Python base: $base; acceptance fixture: $digest"
