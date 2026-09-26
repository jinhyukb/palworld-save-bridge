export class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export function requireThat(condition, code, message) {
  if (!condition) throw new UserError(code, message);
}
