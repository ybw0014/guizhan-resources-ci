# Contracts Documentation

## Build Payload Contract

The CI system expects a JSON payload from the API to trigger a workflow dispatch.

### Schema Fields

Defined in `src/schema.ts` as `buildPayloadSchema`.

- `schema_version`: Must be 1.
- `run_id`: Unique identifier for the build run (alphanumeric).
- `profile_id`: Auto-build profile identifier.
- `project_id`: Project identifier.
- `channel`: Channel name (e.g., "stable").
- `idempotency_key`: Unique key to prevent duplicate builds.
- `source_repo`: GitHub repository (e.g., "owner/repo").
- `source_mode`: Source mode ("branch", "tag", "release").
- `source_identifier`: Target branch, tag, or release name.
- `source_commit_sha`: Commit SHA.
- `build_profile`: Profile name (e.g., "default").
- `runner_repo`: The CI runner repository.
- `runner_workflow`: The workflow file to dispatch.
- `build_command`: The command to run (no shell operators).
- `java_version`: Java version to use.
- `maven_version`: Maven version to use.
- `callback_url`: URL for the status callback.
- `artifact_retention`: Artifact retention period in days (default: 7).

## Callback Contract

The runner callback payload is sent to the API to update the build status.

### Signing

Callback requests must be signed with HMAC-SHA256:
- Secret: `AUTO_BUILD_CALLBACK_SECRET`
- Data: `${timestamp}.${rawBody}`
- Header: `X-Guizhan-Signature`

### Payload

Defined in `src/schema.ts` as `callbackPayloadSchema`.

- Contains `run_id`, `profile_id`, `project_id`, `conclusion`, and artifact references.

## Failure Mapping

| CI Status | Conclusion | Error Message |
|-----------|------------|---------------|
| Dispatch Fail | N/A | HTTP 4xx/5xx from GitHub API |
| Runner Fail | `failure` | `error_message` in callback |
| Runner Timeout | `failure` | Timeout error |
| Manifest Invalid | `failure` | Validation error message |
