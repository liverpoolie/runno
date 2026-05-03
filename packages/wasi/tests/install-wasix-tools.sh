#!/usr/bin/env bash
# Best-effort installer for the WASIX test toolchain.
#
# Probes for `wat2wasm` (from wabt) and `wasixcc` (from the wasix
# toolchain). Anything missing is installed via the host package
# manager where possible. Already-present tools are left alone and the
# script exits 0. A failed install attempt exits non-zero so the caller
# can see what broke.

set -uo pipefail

note() { printf '[install-wasix-tools] %s\n' "$*"; }
fail() { printf '[install-wasix-tools] ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

install_wabt() {
  if have wat2wasm; then
    note "wabt: already installed ($(wat2wasm --version 2>/dev/null || echo unknown))"
    return 0
  fi
  note "wabt: not installed — attempting install"
  case "$(uname -s)" in
    Linux*)
      if have apt-get; then
        sudo apt-get update && sudo apt-get install -y wabt \
          || fail "apt-get install wabt failed"
      else
        fail "no apt-get on this Linux — install wabt manually"
      fi
      ;;
    Darwin*)
      if have brew; then
        brew install wabt || fail "brew install wabt failed"
      else
        fail "Homebrew not found — install wabt manually"
      fi
      ;;
    *)
      fail "unsupported OS $(uname -s) — install wabt manually"
      ;;
  esac
}

install_wasixcc() {
  if have wasixcc; then
    note "wasixcc: already installed ($(wasixcc --version 2>/dev/null | head -n1 || echo unknown))"
    return 0
  fi
  # No automated installer for wasixcc outside CI yet — the upstream
  # composite action (wasix-org/wasixcc) is GitHub-Actions-only. Print
  # the installation pointer and exit non-zero so callers know the
  # toolchain is incomplete.
  fail "wasixcc not on PATH — install via https://github.com/wasix-org/wasix-libc and the matching wasix-toolchain LLVM build"
}

install_wabt
install_wasixcc

note "all tools present"
