export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.message = message;
    Object.assign(this, extra);
  }
}

export function notImplemented(gap, what) {
  return new ApiError(501, "not_implemented", gap + " not implemented", { gap, what: what || null });
}
