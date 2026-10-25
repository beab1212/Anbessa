#!/usr/bin/env bash
# Local development secrets (`make secrets`). Never overwrites a value that is set.
#
#   - creates services/*/.env from .env.example where missing
#   - adds keys that are new in auth-service/.env.example to an existing .env
#   - fills BETTER_AUTH_SECRET and INTERNAL_SERVICE_TOKEN with fresh random values when blank
#
# Staging and production secrets come from the secrets manager (docs/production/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v openssl >/dev/null || { echo "openssl is required to generate secrets"; exit 1; }

AUTH_ENV=services/auth-service/.env
git check-ignore -q "$AUTH_ENV" || { echo "Refusing: $AUTH_ENV is not gitignored"; exit 1; }

umask 077
for example in services/*/.env.example; do
  env_file="${example%.example}"
  if [ ! -f "$env_file" ]; then
    cp "$example" "$env_file"
    echo "  created $env_file"
  fi
done

# keys added to the template after the .env was created
while IFS= read -r line; do
  key="${line%%=*}"
  if ! grep -q "^${key}=" "$AUTH_ENV"; then
    printf '%s\n' "$line" >> "$AUTH_ENV"
    echo "  added $key to $AUTH_ENV"
  fi
done < <(grep -E '^[A-Z_]+=' services/auth-service/.env.example)

# set KEY to a random value if it is empty; the value never reaches the terminal
fill_secret() {
  local key="$1" file="$2" value tmp
  if grep -qE "^${key}=.+" "$file"; then return; fi
  value="$(openssl rand -hex 32)"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$file" > "$tmp"
  cat "$tmp" > "$file" # keep the file's inode and permissions
  rm -f "$tmp"
  echo "  generated $key in $file"
}

fill_secret BETTER_AUTH_SECRET "$AUTH_ENV"
fill_secret INTERNAL_SERVICE_TOKEN "$AUTH_ENV"

chmod 600 "$AUTH_ENV" 2>/dev/null || true
if [ "$(stat -c %a "$AUTH_ENV")" != "600" ]; then
  echo "  ⚠  this filesystem ignores Unix permissions: $AUTH_ENV is readable by other local users."
  echo "     Fine for throwaway dev secrets; never put real secrets on this disk."
fi

if grep -qE '^JWT_(PRIVATE|PUBLIC)_KEY_PATH=' services/*/.env 2>/dev/null; then
  echo "  note: JWT_*_KEY_PATH in your .env files is no longer used (keys now live in the auth database); you can delete those lines and secrets/*.pem"
fi
