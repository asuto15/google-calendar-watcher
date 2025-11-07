#!/bin/bash
(set -a; source .env; curl -X POST "${PUBLIC_WORKER_BASE_URL}/subscribe")
