import React from 'react';
import {
  EDGE_COMPLETENESS_PERCENT_DECIMAL_PLACES,
  EDGE_MEDIAN_LAG_DAYS_DECIMAL_PLACES,
  EDGE_PROBABILITY_PERCENT_DECIMAL_PLACES,
  EDGE_PROBABILITY_STDEV_PERCENT_DECIMAL_PLACES,
} from '@/constants/edgeDisplay';

/**
 * BeadLabelBuilder: Standardized class for constructing bead labels
 * 
 * Ensures consistent logic for:
 * - Checking if values are identical across scenarios (including stdev)
 * - Formatting display text with proper colour coding
 * - Handling hidden current values
 * - Applying formatters uniformly
 * 
 * Use this class for ALL bead label construction to avoid inconsistencies.
 */

export interface BeadValue {
  scenarioId: string;
  value: number | string;
  colour: string;
  stdev?: number;
  /** Optional prefix shown before formatted value (e.g. 'F' or 'E') */
  prefix?: string;
}

export interface HiddenCurrentValue {
  value: number | string;
  stdev?: number;
  /** Optional prefix shown before formatted value (e.g. 'F' or 'E') */
  prefix?: string;
}

export type ValueFormatter = (value: number | string, stdev?: number) => string;

export class BeadLabelBuilder {
  private values: BeadValue[];
  private hiddenCurrent?: HiddenCurrentValue;
  private formatter: ValueFormatter;
  /**
   * Indicates that there is a difference in *existence* of the parameter
   * across layers (some layers have a value, others don't).
   * 
   * In that case we MUST treat this as a delta and avoid full deduplication,
   * even if the numeric values of the layers-that-do-exist are identical.
   */
  private hasExistenceVariation: boolean;
  
  constructor(
    values: BeadValue[],
    hiddenCurrent?: HiddenCurrentValue,
    formatter?: ValueFormatter,
    hasExistenceVariation: boolean = false
  ) {
    this.values = values;
    this.hiddenCurrent = hiddenCurrent;
    this.formatter = formatter || ((v) => String(v));
    this.hasExistenceVariation = hasExistenceVariation;
  }
  
  /**
   * Check if all values are identical (both value AND stdev)
   * This is the CORRECT way to check - must include stdev comparison
   */
  areAllValuesIdentical(): boolean {
    if (this.values.length === 0) return false;
    
    const first = this.values[0];
    return this.values.every(v => 
      v.value === first.value && v.stdev === first.stdev && v.prefix === first.prefix
    );
  }
  
  /**
   * Check if all visible values match the hidden current (both value AND stdev)
   */
  doesHiddenCurrentMatch(): boolean {
    if (!this.hiddenCurrent) return true; // No hidden current = matches by default
    if (this.values.length === 0) return false;
    
    const first = this.values[0];
    return first.value === this.hiddenCurrent.value 
      && first.stdev === this.hiddenCurrent.stdev
      && first.prefix === this.hiddenCurrent.prefix;
  }

  private formatWithOptionalPrefix(value: number | string, stdev?: number, prefix?: string): string {
    const formatted = this.formatter(value, stdev);
    return prefix ? `${prefix} ${formatted}` : formatted;
  }
  
  /**
   * Determine if we should fully deduplicate (show single white value)
   * True only if all visible values are identical AND hidden current matches
   * AND there is no existence variation across layers.
   */
  shouldFullyDeduplicate(): boolean {
    // Existence variation (param present in some layers but not others)
    // is itself a delta and must disable full deduplication.
    if (this.hasExistenceVariation) {
      return false;
    }
    
    return this.areAllValuesIdentical() 
      && (!this.hiddenCurrent || this.doesHiddenCurrentMatch());
  }
  
  /**
   * Build the display text with proper colour coding
   * WHITE text used on dark backgrounds
   */
  buildDisplayText(): React.ReactNode {
    // Case 1: All identical and no differing hidden current
    if (this.shouldFullyDeduplicate()) {
      return (
        <span style={{ color: '#FFFFFF' }}>
          {this.formatWithOptionalPrefix(this.values[0].value, this.values[0].stdev, this.values[0].prefix)}
        </span>
      );
    }
    
    const segments: React.ReactNode[] = [];
    
    // Case 2: Values differ OR all identical but hidden current differs
    if (this.areAllValuesIdentical() && this.hiddenCurrent && !this.doesHiddenCurrentMatch()) {
      // All visible are same, but hidden current differs
      // Show single white value + grey bracketed hidden
      segments.push(
        <span key="visible" style={{ color: '#FFFFFF' }}>
          {this.formatWithOptionalPrefix(this.values[0].value, this.values[0].stdev, this.values[0].prefix)}
        </span>
      );
    } else {
      // Values differ - show each in its scenario colour
      this.values.forEach((val, idx) => {
        segments.push(
          <span key={`value-${idx}`} style={{ color: val.colour }}>
            {this.formatWithOptionalPrefix(val.value, val.stdev, val.prefix)}
          </span>
        );
        if (idx < this.values.length - 1) {
          segments.push(' ');
        }
      });
    }
    
    // Add hidden current if it differs
    if (this.hiddenCurrent && !this.doesHiddenCurrentMatch()) {
      segments.push(' (');
      segments.push(
        <span key="hidden" style={{ color: '#808080' }}>
          {this.formatWithOptionalPrefix(this.hiddenCurrent.value, this.hiddenCurrent.stdev, this.hiddenCurrent.prefix)}
        </span>
      );
      segments.push(')');
    }
    
    return <>{segments}</>;
  }
  
  /**
   * Static helper: Standard probability formatter
   */
  static formatProbability(value: number, stdev?: number): string {
    const percent = value * 100;
    const roundedPercent = Number(percent.toFixed(EDGE_PROBABILITY_PERCENT_DECIMAL_PLACES));
    const stdevPercent = stdev !== undefined ? stdev * 100 : undefined;
    const roundedStdevPercent =
      stdevPercent !== undefined
        ? Number(stdevPercent.toFixed(EDGE_PROBABILITY_STDEV_PERCENT_DECIMAL_PLACES))
        : undefined;

    if (roundedStdevPercent !== undefined && roundedStdevPercent > 0) {
      return `${roundedPercent}% ± ${roundedStdevPercent}%`;
    }
    return `${roundedPercent}%`;
  }
  
  /**
   * Static helper: Standard cost GBP formatter
   */
  static formatCostGBP(value: number, stdev?: number): string {
    if (stdev && stdev > 0) {
      return `£${value.toFixed(2)} ± £${stdev.toFixed(2)}`;
    }
    return `£${value.toFixed(2)}`;
  }
  
  /**
   * Static helper: Standard cost time formatter
   */
  static formatCostTime(value: number, stdev?: number): string {
    if (stdev && stdev > 0) {
      return `${value.toFixed(1)}d ± ${stdev.toFixed(1)}d`;
    }
    return `${value.toFixed(1)}d`;
  }
  
  /**
   * Static helper: Build a label for probability beads
   */
  static buildProbabilityLabel(
    values: BeadValue[],
    hiddenCurrent?: HiddenCurrentValue,
    hasExistenceVariation: boolean = false
  ): { displayText: React.ReactNode; allIdentical: boolean } {
    const builder = new BeadLabelBuilder(
      values, 
      hiddenCurrent, 
      BeadLabelBuilder.formatProbability as ValueFormatter,
      hasExistenceVariation
    );
    return {
      displayText: builder.buildDisplayText(),
      allIdentical: builder.shouldFullyDeduplicate()
    };
  }
  
  /**
   * Static helper: Build a label for cost GBP beads
   */
  static buildCostGBPLabel(
    values: BeadValue[],
    hiddenCurrent?: HiddenCurrentValue,
    hasExistenceVariation: boolean = false
  ): { displayText: React.ReactNode; allIdentical: boolean } {
    const builder = new BeadLabelBuilder(
      values, 
      hiddenCurrent, 
      BeadLabelBuilder.formatCostGBP as ValueFormatter,
      hasExistenceVariation
    );
    return {
      displayText: builder.buildDisplayText(),
      allIdentical: builder.shouldFullyDeduplicate()
    };
  }
  
  /**
   * Static helper: Build a label for cost time beads
   */
  static buildCostTimeLabel(
    values: BeadValue[],
    hiddenCurrent?: HiddenCurrentValue,
    hasExistenceVariation: boolean = false
  ): { displayText: React.ReactNode; allIdentical: boolean } {
    const builder = new BeadLabelBuilder(
      values, 
      hiddenCurrent, 
      BeadLabelBuilder.formatCostTime as ValueFormatter,
      hasExistenceVariation
    );
    return {
      displayText: builder.buildDisplayText(),
      allIdentical: builder.shouldFullyDeduplicate()
    };
  }
  
  /**
   * Static helper: Standard latency formatter
   * value = median_lag_days, stdev = completeness (0-1)
   * Format: "5d / 70%" (median lag days / completeness percentage)
   */
  static formatLatency(value: number, stdev?: number): string {
    const days = Number(value.toFixed(EDGE_MEDIAN_LAG_DAYS_DECIMAL_PLACES));
    const compPct =
      stdev !== undefined
        ? Number((stdev * 100).toFixed(EDGE_COMPLETENESS_PERCENT_DECIMAL_PLACES))
        : 0;
    return `${days}d / ${compPct}%`;
  }
  
  /**
   * Static helper: Build a label for latency beads
   */
  static buildLatencyLabel(
    values: BeadValue[],
    hiddenCurrent?: HiddenCurrentValue,
    hasExistenceVariation: boolean = false
  ): { displayText: React.ReactNode; allIdentical: boolean } {
    const builder = new BeadLabelBuilder(
      values, 
      hiddenCurrent, 
      BeadLabelBuilder.formatLatency as ValueFormatter,
      hasExistenceVariation
    );
    return {
      displayText: builder.buildDisplayText(),
      allIdentical: builder.shouldFullyDeduplicate()
    };
  }
  
  /**
   * Static helper: Build a label with custom formatter
   */
  static buildCustomLabel(
    values: BeadValue[],
    hiddenCurrent: HiddenCurrentValue | undefined,
    formatter: ValueFormatter,
    hasExistenceVariation: boolean = false
  ): { displayText: React.ReactNode; allIdentical: boolean } {
    const builder = new BeadLabelBuilder(
      values, 
      hiddenCurrent, 
      formatter,
      hasExistenceVariation
    );
    return {
      displayText: builder.buildDisplayText(),
      allIdentical: builder.shouldFullyDeduplicate()
    };
  }
}

