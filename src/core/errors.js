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

export const Errors = {
  NOT_FOUND: "NOT_FOUND",
  FROZEN: "RULES_FROZEN",
  DEADLINE: "DEADLINE_PASSED",
  CONFLICT: "CONFLICT_OF_INTEREST",
  STAGE: "STAGE_CLOSED",
  VALIDATION: "VALIDATION",
  STATE: "INVALID_STATE",
  UNAUTHORIZED: "UNAUTHORIZED",
  TAMPERED: "CHAIN_TAMPERED",
  TIE: "UNRESOLVED_TIE",
  SEALED: "BALLOT_SEALED",
};
