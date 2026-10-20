export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export const unavailable = () =>
  new AppError(
    503,
    "We cannot start a new mixtape right now. Your saved version is still available.",
  );
export const conflict = () =>
  new AppError(409, "This draft changed in another tab.");
export const gone = () =>
  new AppError(404, "This mixtape is no longer available.");
