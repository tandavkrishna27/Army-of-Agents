import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitiveBodyFields } from "./redact-sensitive.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.AOA_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
};

// The MCP stdio bridge (cli-mode buildMcpBridgeSpec) sets AOA_LOG_STDOUT=0: the
// bridge owns stdout for JSON-RPC frames, so ANY log written to stdout corrupts
// the protocol and the MCP client sees "Transport closed". In that mode every
// pino record must go to a synchronous stderr destination (sync:true so
// diagnostics flush before a hard exit — pino.destination defaults to async
// buffered SonicBoom, whose buffer is lost on a watchdog process.exit) — no
// pino-pretty transport worker (a transport worker's destination fd is ambiguous
// under the bridge, and stdout must stay byte-pristine). The DEFAULT (non-bridge)
// branch is unchanged: the normal server keeps the pretty→stdout + pretty→file
// transport. The base pino options (level) are identical in both branches.
export const logger =
  process.env.AOA_LOG_STDOUT === "0"
    ? pino({ level: "debug" }, pino.destination({ dest: 2, sync: true }))
    : pino({
        level: "debug",
      }, pino.transport({
        targets: [
          {
            target: "pino-pretty",
            options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
            level: "info",
          },
          {
            target: "pino-pretty",
            options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
            level: "debug",
          },
        ],
      }));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        // ctx.{reqBody,reqParams,reqQuery} are already redacted by error-handler.
        return {
          err: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitiveBodyFields(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitiveBodyFields(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactSensitiveBodyFields(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
