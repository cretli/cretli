/** Format a valid message date using the browser's local calendar and time. */
export function formatChatTimestamp(date, yesterdayLabel, now = new Date()) {
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const sameDay = (other) => date.getFullYear() === other.getFullYear()
    && date.getMonth() === other.getMonth()
    && date.getDate() === other.getDate();
  if (sameDay(now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = sameDay(yesterday)
    ? yesterdayLabel
    : `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  return `${day} ${time}`;
}
