import type { ErrorBody, ErrorCode } from "@dokaanbondhu/contracts";
import { AppError } from "@dokaanbondhu/core";
import { translate } from "@dokaanbondhu/i18n";

// The error shape of every endpoint that does not stream (spec 8.6, Appendix B), in both languages.

export function appError(code: ErrorCode, httpStatus: number, details?: Record<string, unknown>): AppError {
  return new AppError(code, httpStatus, `errors.${code}`, details);
}

export function errorBody(code: ErrorCode, details?: Record<string, unknown>): ErrorBody {
  const key = `errors.${code}`;
  return {
    error: {
      code,
      message_en: translate("en", key),
      message_bn: translate("bn", key),
      message_bn_key: key,
      ...(details ? { details } : {}),
    },
  };
}

/** Turns any thrown value into an error response; unexpected errors become INTERNAL with a request ID. */
export function errorResponse(error: unknown, requestId: string, headers: HeadersInit = {}): Response {
  if (error instanceof AppError) {
    return Response.json(errorBody(error.code as ErrorCode, error.details), {
      status: error.httpStatus,
      headers,
    });
  }
  return Response.json(errorBody("INTERNAL", { request_id: requestId }), { status: 500, headers });
}
