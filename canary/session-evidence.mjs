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
