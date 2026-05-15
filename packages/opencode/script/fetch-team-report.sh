#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Fetch opencode team eval data and the latest generated team_report tool output.

Usage:
  LEAD_SESSION_ID=ses_... ./script/fetch-team-report.sh
  TEAM_ID=team_... RUN_SESSION_ID=ses_... ./script/fetch-team-report.sh
  LEAD_SESSION_ID=ses_... OUTPUT_DIR=./team-report ./script/fetch-team-report.sh

Environment:
  BASE             API base URL. Default: http://localhost:4096
  LEAD_SESSION_ID  Lead session used to resolve the active team.
  TEAM_ID          Team ID. If set, skips the lead-session team lookup.
  RUN_SESSION_ID   Session to search for a completed team_report tool call.
                   Defaults to LEAD_SESSION_ID when available.
  OUTPUT_DIR       If set, writes team-eval JSON, report markdown, and metadata JSON.
  BASIC_AUTH       Optional "username:password" for HTTP basic auth.
  GENERATE_REPORT  If set to 1 and no completed team_report exists, send an
                   async prompt to generate one and print permission/poll steps.

Notes:
  - Eval data is fetched directly from GET /team/:teamID/eval.
  - The formatted report is retrieved from a completed team_report tool part in
    GET /session/:sessionID/message; there is no direct report endpoint.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

check_server() {
  curl -sS --connect-timeout 2 -o /dev/null "$BASE" || die "could not connect to $BASE; start opencode with 'bun run dev serve --port 4096' or set BASE to the running server URL"
}

curl_response() {
  if [[ -n "${BASIC_AUTH:-}" ]]; then
    curl -sS -w '\n%{http_code}' -u "$BASIC_AUTH" "$@"
    return
  fi

  curl -sS -w '\n%{http_code}' "$@"
}

api_get_status() {
  API_BODY=""
  API_STATUS=""

  local response
  if ! response="$(curl_response "$@")"; then
    API_STATUS="000"
    return 1
  fi

  API_STATUS="${response##*$'\n'}"
  API_BODY="${response%$'\n'$API_STATUS}"
}

api_get() {
  if ! api_get_status "$@"; then
    die "request failed: curl could not reach $*"
  fi

  if [[ "$API_STATUS" -ge 400 ]]; then
    printf 'request failed (%s): %s\n' "$API_STATUS" "$*" >&2
    if [[ -n "$API_BODY" ]]; then
      printf '%s\n' "$API_BODY" >&2
    fi
    exit 1
  fi

  printf '%s' "$API_BODY"
}

api_post_json() {
  local body="$1"
  local url="$2"
  api_get -X POST -H "Content-Type: application/json" -d "$body" "$url" >/dev/null
}

load_report_part() {
  report_part=""
  if [[ -z "$RUN_SESSION_ID" ]]; then
    return
  fi

  report_part="$(
    api_get "$BASE/session/$RUN_SESSION_ID/message" \
      | jq -c '[.[].parts[]? | select(.type == "tool" and .tool == "team_report" and .state.status == "completed")] | last // empty'
  )"
}

load_team_id_from_session() {
  if [[ -z "$RUN_SESSION_ID" ]]; then
    return
  fi

  local messages
  messages="$(api_get "$BASE/session/$RUN_SESSION_ID/message")"
  report_part="$(
    printf '%s\n' "$messages" \
      | jq -c '[.[].parts[]? | select(.type == "tool" and .tool == "team_report" and .state.status == "completed")] | last // empty'
  )"

  if [[ -n "$report_part" && "$report_part" != "null" ]]; then
    TEAM_ID="$(printf '%s\n' "$report_part" | jq -r '.state.metadata.team_id // .state.metadata.eval.team_id // empty')"
  fi

  if [[ -n "$TEAM_ID" ]]; then
    return
  fi

  TEAM_ID="$(
    printf '%s\n' "$messages" \
      | jq -r '[.[].parts[]? | select(.type == "tool" and .tool == "team_create" and .state.status == "completed") | (.state.output | fromjson? | .teamID // empty)] | last // empty'
  )"
}

print_report_generation_steps() {
  cat <<STEPS

No completed team_report tool call found in session $RUN_SESSION_ID.

Generate it with:

  curl -sS -X POST "$BASE/session/$RUN_SESSION_ID/prompt_async" \\
    -H "Content-Type: application/json" \\
    -d '
$(jq -n --arg text "Use the team_report tool with team_id $TEAM_ID and return the report." '{parts:[{type:"text",text:$text}]}' | sed 's/^/      /')
    '

If it asks for permission, approve it with:

  curl -sS "$BASE/permission" | jq
  curl -sS -X POST "$BASE/permission/<permission-id>/reply" \\
    -H "Content-Type: application/json" \\
    -d '{"reply":"always"}'

Then rerun this script.
STEPS
}

generate_report() {
  api_post_json "$(
    jq -n --arg text "Use the team_report tool with team_id $TEAM_ID and return the report." \
      '{parts:[{type:"text",text:$text}]}'
  )" "$BASE/session/$RUN_SESSION_ID/prompt_async"

  cat <<STEPS

Queued team_report generation in session $RUN_SESSION_ID.

If it asks for permission, approve it with:

  curl -sS "$BASE/permission" | jq
  curl -sS -X POST "$BASE/permission/<permission-id>/reply" \\
    -H "Content-Type: application/json" \\
    -d '{"reply":"always"}'

Then rerun this script after the session finishes.
STEPS
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_command curl
require_command jq

BASE="${BASE:-http://localhost:4096}"
BASE="${BASE%/}"
LEAD_SESSION_ID="${LEAD_SESSION_ID:-}"
TEAM_ID="${TEAM_ID:-}"
RUN_SESSION_ID="${RUN_SESSION_ID:-${LEAD_SESSION_ID:-}}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
GENERATE_REPORT="${GENERATE_REPORT:-}"
API_BODY=""
API_STATUS=""
report_part=""

check_server

if [[ -z "$TEAM_ID" ]]; then
  if [[ -z "$LEAD_SESSION_ID" && -z "$RUN_SESSION_ID" ]]; then
    usage >&2
    die "set TEAM_ID, LEAD_SESSION_ID, or RUN_SESSION_ID"
  fi

  if [[ -n "$LEAD_SESSION_ID" ]]; then
    if api_get_status -G "$BASE/team" --data-urlencode "sessionID=$LEAD_SESSION_ID" && [[ "$API_STATUS" -lt 400 ]]; then
      TEAM_ID="$(printf '%s\n' "$API_BODY" | jq -r '.id // empty')"
    else
      printf 'warning: could not resolve active team for lead session %s via GET /team (status %s).\n' "$LEAD_SESSION_ID" "${API_STATUS:-000}" >&2
      if [[ -n "$API_BODY" ]]; then
        printf '%s\n' "$API_BODY" >&2
      fi
    fi
  fi

  if [[ -z "$TEAM_ID" && -n "$RUN_SESSION_ID" ]]; then
    load_team_id_from_session
  fi

  [[ -n "$TEAM_ID" ]] || die "no team ID resolved; pass TEAM_ID explicitly, or run this from the lead session that contains the team_create tool call"
fi

eval_json="$(api_get "$BASE/team/$TEAM_ID/eval")"

if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
  printf '%s\n' "$eval_json" | jq '.' >"$OUTPUT_DIR/team-eval-$TEAM_ID.json"
  printf 'wrote %s\n' "$OUTPUT_DIR/team-eval-$TEAM_ID.json"
else
  printf '\n== Team eval (%s) ==\n' "$TEAM_ID"
  printf '%s\n' "$eval_json" | jq '.'
fi

if [[ -z "$RUN_SESSION_ID" ]]; then
  printf '\nNo RUN_SESSION_ID set; skipping team_report lookup.\n' >&2
  exit 0
fi

if [[ -z "$report_part" ]]; then
  load_report_part
fi

if [[ -z "$report_part" || "$report_part" == "null" ]]; then
  if [[ "$GENERATE_REPORT" == "1" ]]; then
    generate_report
    exit 0
  fi

  print_report_generation_steps >&2
  exit 0
fi

if [[ -n "$OUTPUT_DIR" ]]; then
  printf '%s\n' "$report_part" | jq -r '.state.output' >"$OUTPUT_DIR/team-report-$RUN_SESSION_ID.md"
  printf '%s\n' "$report_part" | jq '.state.metadata' >"$OUTPUT_DIR/team-report-metadata-$RUN_SESSION_ID.json"
  printf 'wrote %s\n' "$OUTPUT_DIR/team-report-$RUN_SESSION_ID.md"
  printf 'wrote %s\n' "$OUTPUT_DIR/team-report-metadata-$RUN_SESSION_ID.json"
else
  printf '\n== Team report (%s) ==\n' "$RUN_SESSION_ID"
  printf '%s\n' "$report_part" | jq -r '.state.output'
  printf '\n== Team report metadata ==\n'
  printf '%s\n' "$report_part" | jq '.state.metadata'
fi
