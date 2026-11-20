#!/bin/sh
# Builds the release APK and installs it on the phone plugged in over USB,
# keeping the app's data (same upload key, so it installs as an update).
# On main it pulls the latest commits first; on any other branch it builds
# what is checked out. Run from anywhere in the repository:
#   npm run phone
# Several phones attached: ANDROID_SERIAL=<id> npm run phone
set -e
cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -x /usr/libexec/java_home ]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 21)"   # Gradle fails on newer JDKs
fi
adb=$(command -v adb || echo "$ANDROID_HOME/platform-tools/adb")

# Find the phone first, so a missing cable doesn't cost a whole build.
serial="$ANDROID_SERIAL"
if [ -z "$serial" ]; then
  phones=$("$adb" devices | awk 'NR > 1 && $2 == "device" && $1 !~ /^emulator-/ { print $1 }')
  if [ -z "$phones" ]; then
    if "$adb" devices | grep -q unauthorized; then
      echo "The phone hasn't allowed USB debugging yet: unlock it and tap Allow, then run this again."
    else
      echo "No phone found. Plug it in over USB with USB debugging on, then run this again."
    fi
    exit 1
  fi
  if [ "$(echo "$phones" | wc -l)" -gt 1 ]; then
    echo "Several phones are connected. Pick one: ANDROID_SERIAL=<id> npm run phone"
    echo "$phones"
    exit 1
  fi
  serial=$phones
fi
model=$("$adb" -s "$serial" shell getprop ro.product.model | tr -d '\r')
abi=$("$adb" -s "$serial" shell getprop ro.product.cpu.abi | tr -d '\r')

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = main ]; then
  git pull --ff-only origin main
else
  echo "On branch $branch: building it as it is, without pulling main."
fi

# npm writes node_modules/.package-lock.json on every install.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

# A worktree has no android/key.properties: borrow the main checkout's for this build,
# or the APK would be signed with the debug key and could not update the installed app.
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
if [ ! -f android/key.properties ] && [ -f "$main/android/key.properties" ]; then
  trap 'rm -f android/key.properties' EXIT
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      storeFile=/*) ;;
      storeFile=*) line="storeFile=$main/android/${line#storeFile=}" ;;
    esac
    echo "$line"
  done < "$main/android/key.properties" > android/key.properties
fi

(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures="$abi")

if ! out=$("$adb" -s "$serial" install -r android/app/build/outputs/apk/release/app-release.apk 2>&1); then
  echo "$out"
  case $out in
    *UPDATE_INCOMPATIBLE*) echo "The app on the phone is signed with another key. Only uninstalling it lets this build on, and that deletes its data." ;;
  esac
  exit 1
fi
echo "Installed on $model: $(git log -1 --format='%h %s')"
