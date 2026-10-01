/** 领域错误：携带机器可读 code，便于适配层映射 HTTP 状态。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new DomainError(code, message, details);
};
