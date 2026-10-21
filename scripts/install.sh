#!/usr/bin/env bash
# Links this folder into OMP's extensions directory, then runs one real /capture against a
# throwaway store. Exits 0 only when the capture was saved AND interpreted (ready or
# needs_context); a failed extraction (no model, bad credentials, dead proxy) exits 1.
# Needs only omp: Bun is for development, not for running the extension.
set -u
repo=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)
ext_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/extensions"
link="$ext_dir/capture"
VERIFIED="18.12" # OMP minor line the extension was built and checked against

command -v omp >/dev/null || { echo "FAIL: omp is not on PATH. Install Oh My Pi first."; exit 1; }
version=$(omp --version 2>/dev/null | sed -n 's|^omp/||p')
case "$version" in
  "$VERIFIED".*) echo "omp $version (verified line: $VERIFIED.x)" ;;
  *) echo "WARNING: omp ${version:-unknown} is outside the verified $VERIFIED.x line; the extension API may differ." ;;
esac

mkdir -p "$ext_dir" || exit 1
old=""
if [ -L "$link" ]; then
  old=$(readlink "$link")
elif [ -e "$link" ]; then
  echo "FAIL: $link exists and is not a symlink; move it aside first."; exit 1
fi
if [ "$old" = "$repo" ]; then
  echo "Already linked: $link -> $repo"
else
  [ -n "$old" ] && echo "Replacing $link -> $old"
  ln -sfn "$repo" "$link" || exit 1
  echo "Linked $link -> $repo"
fi
[ -e "$repo/.git" ] || echo "Note: this copy is not a git clone; update it by downloading again into the same folder."
echo "The link points at this exact folder: moving, renaming or deleting it breaks the install."

work=$(mktemp -d)
store="$work/store"
echo
echo "Install check: one /capture, one model call through your current OMP model."
echo "Store: $store"
out=$(cd "$work" && OMP_CAPTURE_DIR="$store" omp --no-session -p "/capture install check" 2>&1)
code=$?
printf '%s\n' "$out"
if [ "$code" -ne 0 ]; then echo "FAIL: omp exited $code"; exit 1; fi
# Judge by the store, not the output: if the extension did not load, `/capture` falls through
# to the model as a plain prompt, and its reply could contain any text. Only the extension
# writes records here.
records=$(find "$store" -maxdepth 1 -name '*.json' ! -name '.*' 2>/dev/null)
count=$(printf '%s' "$records" | grep -c .)
if [ "$count" -ne 1 ]; then
  echo "FAIL: expected 1 record in the store, found $count; the extension did not load."; exit 1
fi
# Records are 2-space-indented JSON; the top-level state is the only key at that depth.
if grep -qE '^  "state": "(ready|needs_context)",$' "$records"; then
  echo "install check: ok (needs_context is the expected result: the check session has no history to interpret)"
  echo "Inspect it with: OMP_CAPTURE_DIR=$store omp --no-session -p '/capture-list'"
  exit 0
fi
echo "FAIL: the capture was saved but not interpreted; the record stays raw with the error above."
echo "Check that your current OMP model works (omp -p 'hello'), then rerun this script."
exit 1
