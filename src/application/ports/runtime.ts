export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
