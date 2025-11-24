/**
 * Date Formatting Utilities
 * 
 * All dates in context DSL MUST use d-MMM-yy format (unambiguous).
 * Examples: 1-Jan-25, 15-Mar-25, 31-Dec-25
 */

/**
 * Format date to d-MMM-yy (e.g., "1-Jan-25", "15-Mar-25")
 * 
 * @param date - Date object or ISO string (YYYY-MM-DD or ISO 8601)
 * @returns Formatted date string
 */
export function formatDateUK(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  
  const day = d.getDate(); // 1-31 (no leading zero)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = String(d.getFullYear()).slice(-2); // Last 2 digits
  
  return `${day}-${month}-${year}`;
}

/**
 * Parse d-MMM-yy date to Date object
 * 
 * @param dateStr - Date in d-MMM-yy format (e.g., "1-Jan-25")
 * @returns Date object
 */
export function parseUKDate(dateStr: string): Date {
  // Format: d-MMM-yy (e.g., "1-Jan-25", "15-Mar-25")
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`Invalid d-MMM-yy format: ${dateStr}`);
  }
  
  const day = parseInt(parts[0], 10);
  const monthStr = parts[1];
  const yearShort = parseInt(parts[2], 10);
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(monthStr);
  
  if (month === -1) {
    throw new Error(`Invalid month: ${monthStr}`);
  }
  
  // Assume 2000s for years 00-50, 1900s for 51-99
  const year = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
  
  return new Date(year, month, day);
}

