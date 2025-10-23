/**
 * Round a number to 4 decimal places to prevent floating-point precision issues
 */
export const roundTo4DP = (value: number): number => {
  return Math.round(value * 10000) / 10000;
};
