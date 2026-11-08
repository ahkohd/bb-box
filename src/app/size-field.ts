export const INVALID_BORDER = "border-destructive";

export function sizeHint(limit: number | null, floor: number | null = null): string {
  if (floor !== null && limit !== null) return `Enter a whole number from ${floor} to ${limit}.`;
  if (limit !== null) return `Enter a whole number from 1 to ${limit}.`;
  return "Enter a whole number from 1 up.";
}

export function sizeInvalid(text: string, limit: number | null, emptyAllowed: boolean, floor: number | null = null): boolean {
  const trimmed = text.trim();
  if (!trimmed) return !emptyAllowed;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return true;
  if (floor !== null && value < floor) return true;
  return limit !== null && value > limit;
}
