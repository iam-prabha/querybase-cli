#!/usr/bin/env bash
# deploy.sh - Build, tag, push to Docker Hub, create git tag
# Usage: ./deploy.sh [version]    # e.g., ./deploy.sh v1.2.3
#        ./deploy.sh              # auto-increments patch from latest tag

set -euo pipefail

# Config
REGISTRY="docker.io"
NAMESPACE="iamprabha010"
IMAGE="querybase"
FULL_IMAGE="${REGISTRY}/${NAMESPACE}/${IMAGE}"

# Get latest tag
get_latest_tag() {
  git tag -l "v*.*.*" --sort=-v:refname | head -1
}

# Determine version
if [[ $# -eq 1 ]]; then
  VERSION="$1"
else
  LATEST=$(get_latest_tag)
  if [[ -z "$LATEST" ]]; then
    VERSION="v0.1.0"
  else
    # Increment patch: v1.2.3 -> v1.2.4
    MAJOR="${LATEST%%.*}"
    REST="${LATEST#*.}"
    MINOR="${REST%%.*}"
    PATCH="${REST#*.}"
    VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
  fi
fi

# Validate version format
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be in format vX.Y.Z (e.g., v1.2.3)"
  exit 1
fi

echo "Deploying ${FULL_IMAGE}:${VERSION}"

# Check if tag already exists
if git rev-parse "${VERSION}" >/dev/null 2>&1; then
  echo "Error: Tag ${VERSION} already exists"
  exit 1
fi

# Build & push
echo "Building ${FULL_IMAGE}:${VERSION}..."
docker build -t "${FULL_IMAGE}:${VERSION}" -t "${FULL_IMAGE}:latest" .

echo "Pushing to Docker Hub..."
docker push "${FULL_IMAGE}:${VERSION}"
docker push "${FULL_IMAGE}:latest"

# Create & push git tag
echo "Creating git tag ${VERSION}..."
git tag "${VERSION}"
git push origin "${VERSION}"

echo "✅ Deployed ${FULL_IMAGE}:${VERSION}"
echo "GitHub Actions will publish to Docker Hub on tag push."