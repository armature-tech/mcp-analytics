#!/usr/bin/env node

import {
  runDoctor,
  type DoctorOptions,
  type DoctorReport,
} from "./doctor.js";
import { parseDoctorArguments } from "./doctor-args.js";

const usage = "Armature MCP analytics doctor\n"
  + "\n"
  + "Usage:\n"
  + "  mcp-analytics doctor --url <http://localhost:3000/mcp> [options]\n"
  + "  mcp-analytics doctor --command <executable> [--arg <value> ...] [options]\n"
  + "\n"
  + "Checks:\n"
  + "  - the local project declares an Armature SDK dependency\n"
  + "  - MCP initialize and tools/list succeed\n"
  + "  - every served tool exposes the Armature telemetry contract\n"
  + "  - marked ingest keys match the MCP and ingest endpoint regions\n"
  + "  - the existing ingest endpoint accepts the configured key\n"
  + "\n"
  + "Options:\n"
  + "  --url <url>             Inspect a running Streamable HTTP MCP server\n"
  + "  --command <executable>  Spawn and inspect a stdio MCP server\n"
  + "  --arg <value>           Add one argument to the stdio command (repeatable)\n"
  + "  --header <name:value>   Add an HTTP MCP header (repeatable; values are never printed)\n"
  + "  --bearer-env <name>     Read an HTTP bearer token from an environment variable\n"
  + "  --cwd <path>            Project directory for dependency detection and stdio spawn\n"
  + "  --timeout <ms>          Per-check timeout (default: 10000)\n"
  + "  --capture <on|off>      Expected telemetry capture state (default: on).\n"
  + "                          Use off for hooks-only or captureTelemetry=false\n"
  + "                          servers, where tools are intentionally unwrapped\n"
  + "                          (tool-call/session analytics still flow).\n"
  + "  --skip-ingest           Do not send the empty authenticated ingest health probe\n"
  + "  --json                  Print a machine-readable report\n"
  + "  --help                  Show this help\n"
  + "\n"
  + "The ingest key is read only from ANALYTICS_INGEST_API_KEY. The health probe\n"
  + "sends {\"schema_version\":1,\"events\":[]} and never sends tool or user content.";

const printReport = (report: DoctorReport): void => {
  console.log("Armature MCP doctor\n");
  for (const check of report.checks) {
    console.log(
      check.status.toUpperCase().padEnd(4) + " " + check.label + ": " + check.detail,
    );
    if (check.remediation) console.log("     Fix: " + check.remediation);
  }
  console.log("\nResult: " + (report.healthy ? "healthy" : "needs attention"));
};

const main = async (): Promise<void> => {
  let options: DoctorOptions;
  try {
    options = parseDoctorArguments(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Error && error.message !== "help") {
      console.error("mcp-analytics doctor: " + error.message + "\n");
    }
    console.error(usage);
    process.exitCode = error instanceof Error && error.message === "help" ? 0 : 2;
    return;
  }

  const report = await runDoctor(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exitCode = report.healthy ? 0 : 1;
};

void main();
