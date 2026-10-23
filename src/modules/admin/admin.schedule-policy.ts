export interface WorkHours {
  starts_at: string;
  ends_at: string;
}

export function getJakartaDayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

export function isWeekend(dateStr: string): boolean {
  const day = getJakartaDayOfWeek(dateStr);
  return day === 0 || day === 6;
}

export function getDefaultWorkHours(dateStr: string): WorkHours | null {
  const day = getJakartaDayOfWeek(dateStr);
  if (day === 0 || day === 6) return null;
  if (day === 5) {
    // Jumat: 08:00 - 17:00 WIB (jam 5 sore)
    return {
      starts_at: `${dateStr}T08:00:00+07:00`,
      ends_at: `${dateStr}T17:00:00+07:00`,
    };
  }
  // Senin - Kamis: 08:00 - 16:30 WIB (jam setengah 5 sore)
  return {
    starts_at: `${dateStr}T08:00:00+07:00`,
    ends_at: `${dateStr}T16:30:00+07:00`,
  };
}
