/**
 * Round a number to a fixed number of decimal places to prevent floating-point precision issues.
 */
export const roundToDecimalPlaces = (value: number, decimalPlaces: number): number => {
  const factor = Math.pow(10, decimalPlaces);
  return Math.round(value * factor) / factor;
};

/**
 * Round a number to 4 decimal places to prevent floating-point precision issues.
 */
export const roundTo4DP = (value: number): number => {
  return roundToDecimalPlaces(value, 4);
};
