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
      throw new Error(`${run.runId}: expected exactly one ${run.harness} session, got ${candidates.length}`);
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
      if (workflowRunIds.length > 1) correlation = `ambiguous: ${workflowRunIds.join(", ")}`;
      else if (workflowRunId && run) correlation = `${run.wave}/${run.modelId}: [${workflowRunId}](${base}/runs/${workflowRunId})`;
      else if (workflowRunId) correlation = `undispatched: [${workflowRunId}](${base}/runs/${workflowRunId})`;
      return `| ${packageName} | ${session.client_name || "unknown"} | ${session.session_key || "missing"} | ${session.event_count} | ${toolNames.join(" → ") || "missing"} | ${correlation} | [${session.id}](${base}/mcp-analytics/sessions/${session.id}) |`;
    }),
    "",
  ].join("\n");
}
