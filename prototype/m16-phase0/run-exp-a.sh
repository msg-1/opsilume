#!/bin/sh
# Experiment A in a one-off container: no network, its own named volume, two tmpfs mounts and a read-only one.
set -e
cd "$(dirname "$0")"
docker run --rm --network none --user 0:0 --entrypoint node -w /proto \
  -v "$PWD":/proto:ro -v "$PWD/results":/results -v opspilot-m16-proto_expa:/vol \
  --tmpfs /mem:rw,size=256m --tmpfs /full:rw,size=64k --tmpfs /ro:ro,size=1m \
  -e N="${N:-2000}" opspilot-isolated-api:latest exp-a.mjs
