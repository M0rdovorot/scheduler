#!/bin/sh
# Recreates the e2e database in the dev Postgres, then runs the backend on it.
# Playwright starts webServer processes before globalSetup, hence a script.
set -eu
psql() { docker exec scheduler-dev-db-1 psql -U scheduler -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
psql 'DROP DATABASE IF EXISTS scheduler_e2e WITH (FORCE)'
psql 'CREATE DATABASE scheduler_e2e'
exec ../bin/scheduler
