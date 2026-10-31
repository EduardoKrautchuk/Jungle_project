export abstract class DomainError<TCode extends string = string> extends Error {
  protected constructor(
    readonly code: TCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
