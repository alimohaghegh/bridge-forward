#!/usr/bin/env bash
# Runs `npx tgcloud run handlers/message <payload>`, prints its output and
# repeats it as one workflow annotation (readable through the GitHub API).
# The payloads used here return counts, codes and checks only — no secrets.
set +x
title="$1"; payload="$2"
# The platform answers "Too many requests" right after a burst: wait and retry.
for try in 1 2 3 4 5; do
  out=$(npx tgcloud run handlers/message "$payload" 2>&1); status=$?
  printf '%s' "$out" | grep -q 'Too many requests' || break
  sleep 15
done
printf '%s\n' "$out"
flat=$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr '\r\n' '  ' | tr -s ' ' | cut -c1-6000 | sed 's/%/%25/g')
printf '::notice title=%s::%s\n' "$title" "$flat"
exit $status
