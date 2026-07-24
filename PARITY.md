# MCP analytics SDK parity

This matrix tracks shared product behavior. Framework-specific adapters differ
by ecosystem and are not expected to share identical APIs. The normative
behavior lives in [`../TELEMETRY-CONTRACT.md`](../TELEMETRY-CONTRACT.md); the
wrapper and release process is documented in
[`../SDK-MAINTENANCE.md`](../SDK-MAINTENANCE.md).

PHP reached supported parity with the `0.1.0` Composer release. Its
implementation and acceptance contract is recorded in the
[PHP SDK specification](../../docs/superpowers/specs/2026-07-24-php-mcp-analytics-sdk.md).

| Behavior | TypeScript | Python | Go | PHP |
| --- | --- | --- | --- | --- |
| V1 telemetry schema and legacy-key normalization | Yes | Yes | Yes | Yes |
| `injected`, `owned`, and `scrub` telemetry modes | Yes | Yes | Yes | Yes |
| Telemetry stripped before business handlers | Yes | Yes | Yes | Yes |
| Customer-owned `telemetry` left untouched | Yes | Yes | Yes | Yes |
| Opt-in telemetry field map | Yes | Yes | Yes | Yes |
| Returned MCP `isError` recorded as failure | Yes | Yes | Yes | Yes |
| Stable `session_init` with client metadata | Yes | Yes | Yes | Yes |
| Stateless/serverless identity-bearing sessions | Yes | Yes | Yes | Yes |
| Process-scoped stdio conversation boundary | Yes | Yes | Yes | Yes |
| Lazy session initialization after a cold start | Yes | Yes | Yes | Yes |
| Bounded session-init deduplication | Yes | Yes | Yes | Yes |
| Workflow-run traffic marked for exclusion | Yes | Yes | Yes | Yes |
| Authorization-header actor fallback | Yes | Yes | Yes | Yes |
| Fresh tool event ID unless an idempotency key is explicit | Yes | Yes | Yes | Yes |
| UTF-8-safe bounded input/output previews | Yes | Yes | Yes | Yes |
| Binary and base64 preview sanitization | Yes | Yes | Yes | Yes |
| Built-in high-confidence secret redaction | Yes | Yes | Yes | Yes |
| Per-value and whole-event redaction hooks | Yes | Yes | Yes | Yes |
| Bounded 1,000-candidate / 20-event privacy queue | Yes | Yes | Yes | Yes |
| Background and request-awaited delivery | Yes | Yes | Yes | Yes |
| Five-second timeout and two-attempt retry policy | Yes | Yes | Yes | Yes |
| In-body ingest rejection surfaced as delivery error | Yes | Yes | Yes | Yes |
| Custom emitter and delivery error callback | Yes | Yes | Yes | Yes |
| Flush and shutdown drain pending work | Yes | Yes | Yes | Yes |
| SDK-owned `request_capability` tool | Yes | Yes | Yes | Yes |
| Exact artifact and Armature readback canary | Yes | Yes | Yes | Yes |
| Deployed Claude Code and Codex isolation canary | Yes | Yes | Yes | Yes |

## Intentional differences

- TypeScript supports MCP SDK and Mastra registration shapes; Python supports
  FastMCP and the official Python SDK; Go supports mark3labs and the official
  Go SDK.
- Loose telemetry validation is the public default in every SDK. Strict schema
  mode is an internal migration/testing facility, not a customer-facing parity
  promise.
- TypeScript and Python can use an event-loop lifecycle hook for background
  serverless work. Go owns a goroutine-backed queue. Portable PHP has no
  standard background runtime, so its specification makes request-awaited
  delivery the safe default and requires an explicit scheduler for deferred
  delivery.
- Language-native configuration names differ. TypeScript uses nested
  camelCase options, Python accepts snake_case plus compatibility aliases, and
  Go uses a typed `Config` struct.
- All implemented SDKs now use a five-second network timeout, two attempts for
  retryable failures, a 100 ms retry delay, a 1,000-candidate queue, and
  batches of at most 20 candidates.
