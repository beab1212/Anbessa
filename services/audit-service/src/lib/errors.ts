import { AppError } from "@ride-app/shared-utils";

export { AppError };

export const badRequest = (message: string, code = "bad_request") => new AppError(400, message, code);
export const forbidden = (message: string, code = "forbidden") => new AppError(403, message, code);
export const notFound = (what: string) => new AppError(404, `${what} not found`, "not_found");
export const conflict = (message: string, code = "conflict") => new AppError(409, message, code);
export const unauthorized = (message = "authentication required") => new AppError(401, message, "unauthorized");
