import { describe, expect, it } from "vitest";

function parseDate(value: string): string | null {
  const v = value.trim().toLowerCase();
  const m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTime(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\./g, ":");
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const minute = Number(m[2] ?? "00");
  if (minute > 59 || h > 23) return null;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

describe("hospital directory parsing", () => {
  it("accepts patient dates in DD/MM/YYYY", () => {
    expect(parseDate("05/10/2026")).toBe("2026-10-05");
    expect(parseDate("31/02/2026")).toBeNull();
  });

  it("accepts 12-hour and 24-hour times", () => {
    expect(parseTime("06:30 PM")).toBe("18:30:00");
    expect(parseTime("09:15")).toBe("09:15:00");
    expect(parseTime("25:00")).toBeNull();
  });
});
