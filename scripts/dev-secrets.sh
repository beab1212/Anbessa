#!/usr/bin/env bash
# Local development secrets (`make secrets`). Never overwrites a value that is set.
#
#   - creates services/*/.env from .env.example where missing
#   - adds keys that are new in the auth/notification .env.example to an existing .env
#   - fills BETTER_AUTH_SECRET, INTERNAL_SERVICE_TOKEN, PHONE_HASH_KEY and OTP_ENCRYPTION_KEY
#     with fresh random values when blank, and copies INTERNAL_SERVICE_TOKEN to notification,
#     location and mapping services
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

NOTIF_ENV=services/notification-service/.env
git check-ignore -q "$NOTIF_ENV" || { echo "Refusing: $NOTIF_ENV is not gitignored"; exit 1; }

# keys added to a template after the .env was created
sync_keys() {
  local env_file="$1" line key
  while IFS= read -r line; do
    key="${line%%=*}"
    if ! grep -q "^${key}=" "$env_file"; then
      printf '%s\n' "$line" >> "$env_file"
      echo "  added $key to $env_file"
    fi
  done < <(grep -E '^[A-Z_]+=' "$env_file.example")
}

# set KEY in FILE to VALUE; the value never reaches the terminal
set_value() {
  local key="$1" file="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$file" > "$tmp"
  cat "$tmp" > "$file" # keep the file's inode and permissions
  rm -f "$tmp"
}

# set KEY to a random value if it is empty
fill_secret() {
  local key="$1" file="$2"
  if grep -qE "^${key}=.+" "$file"; then return; fi
  set_value "$key" "$file" "$(openssl rand -hex 32)"
  echo "  generated $key in $file"
}

sync_keys "$AUTH_ENV"
# services that receive /internal/* calls get the same INTERNAL_SERVICE_TOKEN as auth-service
TOKEN_ENVS=("$NOTIF_ENV" services/location-service/.env services/mapping-service/.env)
for f in "${TOKEN_ENVS[@]}"; do
  git check-ignore -q "$f" || { echo "Refusing: $f is not gitignored"; exit 1; }
  sync_keys "$f"
done

fill_secret BETTER_AUTH_SECRET "$AUTH_ENV"
fill_secret INTERNAL_SERVICE_TOKEN "$AUTH_ENV"
fill_secret PHONE_HASH_KEY "$NOTIF_ENV"
fill_secret OTP_ENCRYPTION_KEY "$NOTIF_ENV"

# one interim service token for all /internal/* calls (until mTLS)
auth_token="$(grep -E '^INTERNAL_SERVICE_TOKEN=' "$AUTH_ENV" | cut -d= -f2-)"
for f in "${TOKEN_ENVS[@]}"; do
  if ! grep -qE "^INTERNAL_SERVICE_TOKEN=${auth_token}$" "$f"; then
    set_value INTERNAL_SERVICE_TOKEN "$f" "$auth_token"
    echo "  copied INTERNAL_SERVICE_TOKEN from $AUTH_ENV to $f"
  fi
done

for f in "$AUTH_ENV" "${TOKEN_ENVS[@]}"; do
  chmod 600 "$f" 2>/dev/null || true
  if [ "$(stat -c %a "$f")" != "600" ]; then
    echo "  ⚠  this filesystem ignores Unix permissions: $f is readable by other local users."
    echo "     Fine for throwaway dev secrets; never put real secrets on this disk."
  fi
done

if grep -qE '^JWT_(PRIVATE|PUBLIC)_KEY_PATH=' services/*/.env 2>/dev/null; then
  echo "  note: JWT_*_KEY_PATH in your .env files is no longer used (keys now live in the auth database); you can delete those lines and secrets/*.pem"
fi
