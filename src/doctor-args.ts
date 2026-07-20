import { resolve } from "node:path";
import { defaultDoctorOptions, type DoctorOptions } from "./doctor.js";

const valueAfter = (
  argv: string[],
  index: number,
  flag: string,
  allowOptionLikeValue = false,
): string => {
  const value = argv[index + 1];
  if (!value || (!allowOptionLikeValue && value.startsWith("--"))) {
    throw new Error(flag + " requires a value");
  }
  return value;
};

const parseHeader = (raw: string): [string, string] => {
  const colon = raw.indexOf(":");
  if (colon <= 0) throw new Error("--header must use NAME: VALUE");
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(name) || !value) {
    throw new Error("--header must use a valid non-empty NAME: VALUE");
  }
  return [name, value];
};

export const parseDoctorArguments = (
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): DoctorOptions => {
  const args = argv[0] === "doctor" ? argv.slice(1) : argv;
  let url: string | undefined;
  let command: string | undefined;
  const commandArgs: string[] = [];
  const headers: Record<string, string> = {};
  let cwd = process.cwd();
  let timeoutMs = 10_000;
  let expectCapture = true;
  let skipIngest = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--url") url = valueAfter(args, index++, flag);
    else if (flag === "--command") command = valueAfter(args, index++, flag);
    else if (flag === "--arg") commandArgs.push(valueAfter(args, index++, flag, true));
    else if (flag === "--header") {
      const [name, value] = parseHeader(valueAfter(args, index++, flag));
      headers[name] = value;
    } else if (flag === "--bearer-env") {
      const envName = valueAfter(args, index++, flag);
      const token = environment[envName];
      if (!token) throw new Error("--bearer-env references unset variable " + envName);
      headers.Authorization = "Bearer " + token;
    } else if (flag === "--cwd") cwd = resolve(valueAfter(args, index++, flag));
    else if (flag === "--timeout") {
      timeoutMs = Number(valueAfter(args, index++, flag));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
        throw new Error("--timeout must be an integer between 100 and 120000");
      }
    } else if (flag === "--capture") {
      const value = valueAfter(args, index++, flag);
      if (!(["on", "off"] as string[]).includes(value)) {
        throw new Error("--capture must be on or off");
      }
      expectCapture = value === "on";
    } else if (flag === "--skip-ingest") skipIngest = true;
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") throw new Error("help");
    else throw new Error("unknown option: " + flag);
  }

  if (Boolean(url) === Boolean(command)) {
    throw new Error("provide exactly one of --url or --command");
  }
  let target: DoctorOptions["target"];
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("--url must use http or https");
    }
    target = { kind: "http" as const, url: parsed.toString(), headers };
  } else {
    target = { kind: "stdio" as const, command: command as string, args: commandArgs, cwd };
  }
  return {
    ...defaultDoctorOptions(target),
    cwd,
    timeoutMs,
    expectCapture,
    skipIngest,
    json,
  };
};
