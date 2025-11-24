import { describe, it, expect } from 'vitest';
import { formatDateUK, parseUKDate } from '../dateFormat';

describe('Date Formatting (d-MMM-yy)', () => {
  describe('formatDateUK', () => {
    it('should format date to d-MMM-yy', () => {
      expect(formatDateUK('2025-01-01')).toBe('1-Jan-25');
      expect(formatDateUK('2025-03-15')).toBe('15-Mar-25');
      expect(formatDateUK('2025-12-31')).toBe('31-Dec-25');
    });
    
    it('should handle Date objects', () => {
      expect(formatDateUK(new Date('2025-01-01'))).toBe('1-Jan-25');
      expect(formatDateUK(new Date('2025-11-24'))).toBe('24-Nov-25');
    });
    
    it('should handle ISO timestamps', () => {
      expect(formatDateUK('2025-01-15T00:00:00Z')).toBe('15-Jan-25');
      expect(formatDateUK('2025-11-23T23:59:59Z')).toBe('23-Nov-25');
    });
    
    it('should throw on invalid dates', () => {
      expect(() => formatDateUK('invalid')).toThrow('Invalid date');
    });
  });
  
  describe('parseUKDate', () => {
    it('should parse d-MMM-yy to Date', () => {
      const date1 = parseUKDate('1-Jan-25');
      expect(date1.getFullYear()).toBe(2025);
      expect(date1.getMonth()).toBe(0); // January = 0
      expect(date1.getDate()).toBe(1);
      
      const date2 = parseUKDate('15-Mar-25');
      expect(date2.getFullYear()).toBe(2025);
      expect(date2.getMonth()).toBe(2); // March = 2
      expect(date2.getDate()).toBe(15);
    });
    
    it('should assume 2000s for years 00-49', () => {
      const date = parseUKDate('1-Jan-25');
      expect(date.getFullYear()).toBe(2025);
      
      const date2 = parseUKDate('1-Jan-49');
      expect(date2.getFullYear()).toBe(2049);
    });
    
    it('should assume 1900s for years 50-99', () => {
      const date = parseUKDate('1-Jan-99');
      expect(date.getFullYear()).toBe(1999);
      
      const date2 = parseUKDate('1-Jan-50');
      expect(date2.getFullYear()).toBe(1950);
    });
    
    it('should throw on invalid format', () => {
      expect(() => parseUKDate('2025-01-01')).toThrow('Invalid month'); // '01' is not a month name
      expect(() => parseUKDate('1/Jan/25')).toThrow('Invalid d-MMM-yy format');
      expect(() => parseUKDate('Jan-1-25')).toThrow(); // Wrong order
    });
    
    it('should throw on invalid month', () => {
      expect(() => parseUKDate('1-Xxx-25')).toThrow('Invalid month');
    });
  });
  
  describe('Round-trip conversion', () => {
    it('should preserve dates through format and parse', () => {
      const original = '2025-01-15';
      const ukFormat = formatDateUK(original);
      const parsed = parseUKDate(ukFormat);
      const backToISO = parsed.toISOString().split('T')[0];
      
      expect(backToISO).toBe(original);
    });
  });
});

