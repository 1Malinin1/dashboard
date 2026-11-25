#!/bin/sh
# Единая точка входа для Git Bash, Linux и проектного хука.
exec node "$(dirname "$0")/run-all.cjs" "$@"
