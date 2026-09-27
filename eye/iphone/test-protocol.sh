#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc "$ROOT/EyePhone/PhoneFrame.swift" "$ROOT/Tests/main.swift" -o "$TEST_DIR/test-protocol"
"$TEST_DIR/test-protocol" "$@"
