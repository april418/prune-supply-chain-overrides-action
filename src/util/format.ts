/**
 * Format a duration in minutes as a short human-readable string.
 *
 * Examples: 30 -> "30m", 90 -> "1h 30m", 14_400 -> "10d", 14_500 -> "10d 1h".
 */
export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.floor(totalMinutes);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}
