import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { redactSensitiveBodyFields } from "./redact-sensitive.js";
import {
  isMarketplaceAdminPath,
  marketplaceErrorResponse,
} from "../services/marketplace-http-contract.js";
import { serializeSafeError } from "../services/safe-error.js";
import {
  isEnrollmentWorkerControlPath,
  sendWorkerProtocolError,
} from "../services/worker-protocol-http.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function isJobSubmissionPath(url: string): boolean {
  return /^\/(?:api\/)?organizations\/[^/]+\/companies\/[^/]+\/jobs(?:\?|$)/.test(url);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (isEnrollmentWorkerControlPath(req.originalUrl) || (res.locals as { workerProtocolV1?: boolean }).workerProtocolV1 === true) {
    const status = err && typeof err === "object"
      ? Number((err as { status?: unknown; statusCode?: unknown }).status ??
        (err as { statusCode?: unknown }).statusCode)
      : Number.NaN;
    const code = err instanceof ZodError
      ? "malformed"
      : err instanceof HttpError && err.status < 500
        ? "unauthorized"
        : status >= 400 && status < 500
          ? "malformed"
          : "internal_unavailable";
    sendWorkerProtocolError(req, res, code);
    return;
  }
  if (isMarketplaceAdminPath(req.originalUrl)) {
    const status =
      err instanceof HttpError
        ? err.status
        : err instanceof ZodError
          ? 400
          : err &&
              typeof err === "object" &&
              ("status" in err || "statusCode" in err)
            ? Number(
                (err as { status?: unknown }).status ??
                  (err as { statusCode?: unknown }).statusCode,
              )
            : 500;
    const safeStatus =
      Number.isInteger(status) && status >= 400 && status < 600
        ? status
        : 500;
    const code =
      safeStatus === 401
        ? "authentication_required"
        : safeStatus === 403
          ? "instance_admin_required"
          : safeStatus >= 400 && safeStatus < 500
            ? "invalid_request"
            : "internal_error";
    if (safeStatus >= 500) {
      const safeError = serializeSafeError(err);
      (res as any).__errorContext = {
        error: {
          message: String(safeError.message ?? "Marketplace request failed"),
          ...(typeof safeError.stack === "string"
            ? { stack: safeError.stack }
            : {}),
          ...(typeof safeError.name === "string"
            ? { name: safeError.name }
            : {}),
        },
        method: req.method,
        url: req.originalUrl,
        reqBody: redactSensitiveBodyFields(req.body),
        reqParams: redactSensitiveBodyFields(req.params),
        reqQuery: redactSensitiveBodyFields(req.query),
      } satisfies ErrorContext;
    }
    res.status(safeStatus).json(marketplaceErrorResponse(code, null));
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      (res as any).__errorContext = {
        error: { message: err.message, stack: err.stack, name: err.name, details: err.details },
        method: req.method,
        url: req.originalUrl,
        reqBody: redactSensitiveBodyFields(req.body),
        reqParams: redactSensitiveBodyFields(req.params),
        reqQuery: redactSensitiveBodyFields(req.query),
      } satisfies ErrorContext;
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  // body-parser / Express middleware throws plain errors with .status (and/or
  // .statusCode) plus .expose=true for client-safe messages — most notably
  // PayloadTooLargeError (413) from `express.json({ limit })`. Honor those
  // before falling through to 500.
  if (
    err
    && typeof err === "object"
    && ("status" in err || "statusCode" in err)
  ) {
    const status = Number(
      (err as { status?: unknown }).status
        ?? (err as { statusCode?: unknown }).statusCode,
    );
    if (Number.isInteger(status) && status >= 400 && status < 600) {
      const message = (err as { message?: unknown }).message;
      const expose = (err as { expose?: unknown }).expose === true;
      res.status(status).json({
        error: expose && typeof message === "string" ? message : "Request error",
      });
      return;
    }
  }

  if (isJobSubmissionPath(req.originalUrl)) {
    (res as any).__jobSubmissionLogContext ??= {
      organizationId: req.params.organizationId,
      companyId: req.params.companyId,
      sourceKind: req.body?.source?.kind,
      replayed: false,
      reasonCode: "job_submission_internal_error",
    };
    (res as any).__errorContext = {
      error: { message: "Job submission failed", name: "JobSubmissionError" },
      method: req.method,
      url: req.originalUrl,
      reqParams: {
        organizationId: req.params.organizationId,
        companyId: req.params.companyId,
      },
    } satisfies ErrorContext;
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  (res as any).__errorContext = {
    error: err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err },
    method: req.method,
    url: req.originalUrl,
    reqBody: redactSensitiveBodyFields(req.body),
    reqParams: redactSensitiveBodyFields(req.params),
    reqQuery: redactSensitiveBodyFields(req.query),
  } satisfies ErrorContext;

  res.status(500).json({ error: "Internal server error" });
}
