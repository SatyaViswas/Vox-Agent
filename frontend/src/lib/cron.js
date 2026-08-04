export const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const pad = (n) => String(n).padStart(2, "0");

export function parseSchedule(triggerType, cronSchedule) {
  if (triggerType === "event_trigger") {
    return { preset: "event_trigger", time: "09:00", day: 1, raw: "" };
  }
  if (triggerType !== "scheduled" || !cronSchedule) {
    return { preset: "on_demand", time: "09:00", day: 1, raw: "" };
  }

  const hourlyMatch = cronSchedule.match(/^0 \* \* \* \*$/);
  if (hourlyMatch) return { preset: "hourly", time: "09:00", day: 1, raw: cronSchedule };

  const dailyMatch = cronSchedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (dailyMatch) {
    return { preset: "daily", time: `${pad(dailyMatch[2])}:${pad(dailyMatch[1])}`, day: 1, raw: cronSchedule };
  }

  const weeklyMatch = cronSchedule.match(/^(\d{1,2}) (\d{1,2}) \* \* (\d)$/);
  if (weeklyMatch) {
    return {
      preset: "weekly",
      time: `${pad(weeklyMatch[2])}:${pad(weeklyMatch[1])}`,
      day: Number(weeklyMatch[3]),
      raw: cronSchedule,
    };
  }

  return { preset: "custom", time: "09:00", day: 1, raw: cronSchedule };
}

export function buildSchedule(preset, { time = "09:00", day = 1, raw = "" } = {}) {
  const [hh, mm] = time.split(":").map(Number);
  switch (preset) {
    case "event_trigger":
      return { triggerType: "event_trigger", cronSchedule: null };
    case "on_demand":
    case "manual":
      return { triggerType: "on_demand", cronSchedule: null };
    case "hourly":
      return { triggerType: "scheduled", cronSchedule: "0 * * * *" };
    case "daily":
      return { triggerType: "scheduled", cronSchedule: `${mm} ${hh} * * *` };
    case "weekly":
      return { triggerType: "scheduled", cronSchedule: `${mm} ${hh} * * ${day}` };
    case "custom":
      return { triggerType: "scheduled", cronSchedule: raw.trim() || null };
    default:
      return { triggerType: "on_demand", cronSchedule: null };
  }
}

export function describeSchedule(triggerType, cronSchedule) {
  if (triggerType !== "scheduled" || !cronSchedule) return "Manual trigger";
  const { preset, time, day } = parseSchedule(triggerType, cronSchedule);
  if (preset === "hourly") return "Every hour";
  if (preset === "daily") return `Daily at ${time}`;
  if (preset === "weekly") return `Every ${DAYS_OF_WEEK[day]?.label ?? "week"} at ${time}`;
  return `Custom: ${cronSchedule}`;
}
