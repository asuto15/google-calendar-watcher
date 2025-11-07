#!/bin/bash
(set -a; source .env; tsx scripts/get-refresh-token.ts)