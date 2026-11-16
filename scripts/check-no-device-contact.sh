#!/bin/sh
# Prove the unit suite does not touch a device or a running app.
#
# Runs jest with a fresh HOME (first-run code paths, no saved flags), stubs for the
# device CLIs that log their arguments and fail, and a preload that refuses and logs
# any connection to Metro / Chromium ports. Exits 1 on any contact.
#
#   scripts/check-no-device-contact.sh                       # whole suite
#   scripts/check-no-device-contact.sh --testPathPatterns=X  # extra args go to jest
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd -P)
# pwd -P: /var is a symlink on macOS, and projectStore tests compare against the resolved HOME.
S=$(cd "$(mktemp -d)" && pwd -P)
mkdir -p "$S/home/.local/bin"
for b in adb xcrun pymobiledevice3 idb axe; do
    printf '#!/bin/sh\necho "%s $*" >> %s/calls.log\nexit 1\n' "$b" "$S" > "$S/$b"
    chmod +x "$S/$b"
done
# execbro runs ~/.local/bin/pymobiledevice3 by absolute path when it exists, past PATH.
cp "$S/pymobiledevice3" "$S/home/.local/bin/"
: > "$S/calls.log"
: > "$S/metro.log"

HOME="$S/home" PATH="$S:$PATH" METRO_CONTACT_LOG="$S/metro.log" \
    NODE_OPTIONS="--experimental-vm-modules --require $ROOT/scripts/no-metro-contact.cjs" \
    "$ROOT/node_modules/.bin/jest" "$@"
jest_status=$?

# Availability probes are expected; anything else reached for a device.
cli=$(grep -vxE "adb version|xcrun simctl help|xcrun simctl list devices booted -j" "$S/calls.log")
status=0
if [ -n "$cli" ]; then
    printf "\n%s\n" "Device CLI calls from the suite:"; echo "$cli" | sort | uniq -c
    status=1
fi
if [ -s "$S/metro.log" ]; then
    printf "\n%s\n" "Connections to an app port from the suite (refused):"; cat "$S/metro.log"
    status=1
fi
[ $status -eq 0 ] && printf "\nNo device contact.\n"
rm -rf "$S"
[ $jest_status -ne 0 ] && exit $jest_status
exit $status
