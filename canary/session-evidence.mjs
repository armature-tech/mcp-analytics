export async function collectSessionEvidence({ base, headers, matches, dispatch, fetchImpl = fetch }) {
  const runsById = new Map(dispatch.runs.map((run) => [run.runId, run]));
  return Promise.all(matches.map(async (session) => {
    const response = await fetchImpl(`${base}/api/armature/v1/insights/sessions/${session.id}/trace`, { headers });
    if (!response.ok) throw new Error(`${session.id}: trace read failed: HTTP ${response.status}`);
    const trace = await response.json();
    const traceWorkflowRunIds = (Array.isArray(trace?.events) ? trace.events : [])
      .map((event) => event?.metadata?.workflow_run_id)
      .filter((value) => typeof value === "string" && value.length > 0);
    const sessionKey = String(session.session_key || "");
    const seededRunIds = dispatch.runs
      .map((run) => run.runId)
      .filter((runId) => sessionKey.includes(runId));
    const workflowRunIds = [...new Set([...seededRunIds, ...traceWorkflowRunIds])];
    const toolNames = (Array.isArray(trace?.events) ? trace.events : [])
      .map((event) => event?.metadata?.tool_name)
      .filter((name) => typeof name === "string" && name);
    const workflowRunId = workflowRunIds.length === 1 ? workflowRunIds[0] : null;
    const run = workflowRunId ? runsById.get(workflowRunId) : null;
    return { session, trace, text: JSON.stringify(trace), toolNames, workflowRunIds, workflowRunId, run: run || null };
  }));
}

export function harnessFamily(session) {
  const client = String(session?.client_name || "").trim().toLowerCase();
  if (client === "mcp-tester-claude-remote-proxy" || /claude[ _-]*code/.test(client)) return "claude_code";
  if (/codex/.test(client)) return "codex";
  return `unexpected:${client || "unknown"}`;
}

export function withExpectedHarnesses(dispatch) {
  const modelIds = [...new Set((dispatch?.runs || []).map((run) => run.modelId))];
  if (modelIds.length !== 2) {
    throw new Error(`expected two ordered harness models, got ${modelIds.length}`);
  }
  // The dispatch API has always returned Claude first and Codex second. New
  // deployments also return run.harness explicitly; derive it for canaries
  // that begin while the platform is still serving the previous API version.
  const harnessByModel = new Map([
    [modelIds[0], "claude_code"],
    [modelIds[1], "codex"],
  ]);
  return {
    ...dispatch,
    runs: dispatch.runs.map((run) => ({
      ...run,
      harness: run.harness || harnessByModel.get(run.modelId),
    })),
  };
}

// Identity-bearing stateless session keys look like
// `mcp:mcp_<client>_v_<version>_<uuid>`, where the uuid is the
// X-Armature-Session-Seed the server honored at mint time (the workflow run
// id for harness traffic). Returns the embedded uuid, lowercased, or null
// for any other key shape.
const STATELESS_SESSION_KEY_UUID_RE =
  /^mcp:mcp_[A-Za-z0-9.-]+_v_[A-Za-z0-9.-]*_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function sessionSeedUuid(sessionKey) {
  const match = STATELESS_SESSION_KEY_UUID_RE.exec(String(sessionKey || ""));
  return match ? match[1].toLowerCase() : null;
}

// The stable canary URL is shared, and the readback matches sessions by the
// deployed marker intent, which ANY agent hitting the deployment inherits
// from the tool descriptions. Traffic from workflow runs this dispatch did
// not create can therefore land in the readback window: a concurrent canary
// CI run, or the platform's system-error retry sweeper, which resurrects an
// EARLIER dispatch's runs (canary dispatches skip the evaluator, so those
// runs terminalize as timed_out/evaluator_not_started ~1h later and are
// retried under fresh run ids that replay the whole conversation against
// the currently promoted deployment).
//
// Such sessions are healthy — their keys embed the seed of a real (foreign)
// workflow run — so they must not fail the per-session correlation gate.
// They are only classified foreign when the key is a WELL-FORMED
// identity-bearing stateless key whose embedded uuid matches no dispatched
// run and the trace carries no correlation either. Malformed, bare-uuid, or
// fallback-bucketed keys stay in `ours` so hint-loss regressions still fail
// loudly, and a genuine seed regression (random mints) is still caught by
// selectExpectedHarnessEvidence: the dispatched runs would then have no
// seeded session at all.
export function partitionHarnessEvidence({ dispatch, evidence }) {
  const dispatched = new Set(dispatch.runs.map((run) => String(run.runId).toLowerCase()));
  const ours = [];
  const foreign = [];
  for (const item of evidence) {
    const seed = sessionSeedUuid(item.session?.session_key);
    if (item.workflowRunIds.length === 0 && seed && !dispatched.has(seed)) {
      foreign.push(item);
    } else {
      ours.push(item);
    }
  }
  return { ours, foreign };
}

// A real harness may start a correlated wrong-family fallback attempt before
// the requested runner succeeds. Require exactly one correct-family session
// for every dispatched run; extra fallback sessions remain visible in the
// evidence table and still pass the correlation/error checks in the caller.
export function selectExpectedHarnessEvidence({ dispatch, evidence }) {
  return dispatch.runs.map((run) => {
    const candidates = evidence.filter((item) => (
      item.workflowRunId === run.runId && harnessFamily(item.session) === run.harness
    ));
    if (candidates.length !== 1) {
      const cappedHint = candidates.length === 0
        ? " (if ingest succeeded, zero visible sessions usually means the canary organization is subject to a free-tier session-visibility cap; keep the canary org on a non-free plan)"
        : "";
      throw new Error(`${run.runId}: expected exactly one ${run.harness} session, got ${candidates.length}${cappedHint}`);
    }
    return candidates[0];
  });
}

export function formatSessionEvidence({ packageName, base, dispatch, evidence }) {
  return [
    "| Package | Wave | Harness model | Workflow run |",
    "|---|---|---|---|",
    ...dispatch.runs.map((run) => `| ${packageName} | ${run.wave} | ${run.modelId} | [${run.runId}](${base}/runs/${run.runId}) |`),
    "",
    "| Package | Client | Session key | Events | Tools | Workflow correlation | Platform session |",
    "|---|---|---|---:|---|---|---|",
    ...evidence.map(({ session, toolNames, workflowRunIds, workflowRunId, run }) => {
      let correlation = "missing";
      const foreignSeed = workflowRunIds.length === 0 ? sessionSeedUuid(session?.session_key) : null;
      if (workflowRunIds.length > 1) correlation = `ambiguous: ${workflowRunIds.join(", ")}`;
      else if (workflowRunId && run) correlation = `${run.wave}/${run.modelId}: [${workflowRunId}](${base}/runs/${workflowRunId})`;
      else if (workflowRunId) correlation = `undispatched: [${workflowRunId}](${base}/runs/${workflowRunId})`;
      else if (foreignSeed) correlation = `foreign: [${foreignSeed}](${base}/runs/${foreignSeed})`;
      return `| ${packageName} | ${session.client_name || "unknown"} | ${session.session_key || "missing"} | ${session.event_count} | ${toolNames.join(" → ") || "missing"} | ${correlation} | [${session.id}](${base}/mcp-analytics/sessions/${session.id}) |`;
    }),
    "",
  ].join("\n");
}
