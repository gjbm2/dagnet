export class DASExecutionError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DASExecutionError';
  }
}

export class CredentialsError extends DASExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, 'credentials', details);
    this.name = 'CredentialsError';
  }
}

export class TemplateError extends DASExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, 'template', details);
    this.name = 'TemplateError';
  }
}

export class ExtractionError extends DASExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, 'extraction', details);
    this.name = 'ExtractionError';
  }
}

export class TransformationError extends DASExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, 'transformation', details);
    this.name = 'TransformationError';
  }
}

export class UpdateBuildError extends DASExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, 'update', details);
    this.name = 'UpdateBuildError';
  }
}




