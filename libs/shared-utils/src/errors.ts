export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code: string) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`, "not_found");
  }
}
