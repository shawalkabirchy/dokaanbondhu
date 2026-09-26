/** The one error type (spec 3.5): a stable code, the HTTP status, a message key for the app, and details. */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly messageKey: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, httpStatus: number, messageKey: string, details?: Record<string, unknown>) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.messageKey = messageKey;
    this.details = details;
  }
}
