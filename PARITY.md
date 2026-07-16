# MCP analytics SDK parity

This matrix tracks shared product behavior. Framework-specific adapters differ
by ecosystem and are not expected to share identical APIs.

| Behavior | TypeScript | Python | Go |
| --- | --- | --- | --- |
| V1 telemetry schema and legacy-key normalization | Yes | Yes | Yes |
| Telemetry stripped before business handlers | Yes | Yes | Yes |
| Returned MCP `isError` recorded as failure | Yes | Yes | Yes |
| Stable `session_init` with client metadata | Yes | Yes | Yes |
| Stateless/serverless identity-bearing sessions | Yes | Yes | Yes |
| Process-scoped stdio conversation boundary | Yes | Yes | Yes |
| Lazy session initialization after a cold start | Yes | Yes | Yes |
| Bounded session-init deduplication | Yes | Yes | Yes |
| Workflow-run traffic marked for exclusion | Yes | Yes | Yes |
| Authorization-header actor fallback | Yes | Yes | Yes |
| Background and request-awaited delivery | Yes | Yes | Yes |
| Custom emitter and delivery error callback | Yes | Yes | Yes |
| Fresh tool event ID unless an idempotency key is explicit | Yes | Yes | Yes |
| UTF-8-safe bounded input/output previews | Yes | Yes | Yes |

## Intentional differences

- TypeScript supports MCP SDK and Mastra registration shapes; Python supports
  FastMCP and the official Python SDK; Go supports mark3labs and the official
  Go SDK.
- Loose telemetry validation is the public default in every SDK. Strict schema
  mode is an internal migration/testing facility, not a customer-facing parity
  promise.
- Go's network timeout defaults to five seconds; TypeScript and Python default
  to 500 ms. Go delivery runs outside the tool path by default and uses the
  longer timeout to tolerate cold network setup.
