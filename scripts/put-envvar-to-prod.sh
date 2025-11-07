#!/usr/bin/env bash

ENVFILE=".env"

while IFS='=' read -r KEY VALUE; do
  if [[ -z "$KEY" ]] || [[ "$KEY" =~ ^# ]]; then
    continue
  fi

  echo "Setting $KEY"
  echo -n "$VALUE" | wrangler secret put "$KEY"
done < "$ENVFILE"
