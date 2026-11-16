#!/bin/bash
# Runs the orchestrator test suite (the three *.test.mjs files).
# fake-claude.mjs and helpers.mjs are support files, not tests.
cd "$(dirname "$0")/.."
export ORCH_TEST_ALLOW_7171=1
exec node --test test/ask.test.mjs test/waiting.test.mjs test/answer.test.mjs "$@"
