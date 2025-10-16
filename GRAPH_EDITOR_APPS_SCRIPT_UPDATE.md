# Graph Editor and Apps Script Updates for New Cost Structure

## Overview

Updated the graph editor and Apps Script to handle the new cost structure with time in days, standard deviation support, and distribution parameters for both monetary and time costs.

## Changes Made

### 1. **Graph Editor Updates** (`PropertiesPanel.tsx`)

#### **Enhanced Edge Cost UI**
- **Monetary Cost Section**
  - Value input with currency selector (GBP, USD, EUR)
  - Standard deviation input (optional)
  - Distribution selector (normal, lognormal, gamma, uniform)
  - Default: GBP currency, normal distribution

- **Time Cost Section**
  - Value input with units selector (days, hours, weeks)
  - Standard deviation input (optional)
  - Distribution selector (normal, lognormal, gamma, uniform)
  - Default: days units, lognormal distribution

#### **New Cost Structure Support**
```typescript
// New cost structure in edge properties
costs: {
  monetary: {
    value: 0.50,
    stdev: 0.1,
    distribution: "normal",
    currency: "GBP"
  },
  time: {
    value: 1.5,
    stdev: 0.5,
    distribution: "lognormal",
    units: "days"
  }
}
```

### 2. **Apps Script Updates** (`dagnet-apps-script-simple.js`)

#### **Updated Cost Calculation Functions**

**`calculateCost()` Function:**
- Handles new `edge.costs.monetary.value` structure
- Backward compatibility with old `edge.costs.monetary` number format
- Supports currency and distribution metadata

**`calculateTime()` Function:**
- Handles new `edge.costs.time.value` structure (in days)
- Unit conversion: hours → days, weeks → days
- Backward compatibility with old `edge.costs.time` number format
- Supports units and distribution metadata

#### **Updated Parameter Extraction Functions**

**`flattenEdgeParameters()` Function:**
- Extracts monetary cost parameters: `value`, `stdev`, `currency`, `distribution`
- Extracts time cost parameters: `value`, `stdev`, `units`, `distribution`
- Backward compatibility with old cost structure
- Only includes non-zero values and non-default settings

**`flattenAllEdgeParameters()` Function:**
- Includes all cost parameters (even zeros) for complete parameter extraction
- Supports both new object structure and old number structure
- Comprehensive parameter reporting for analytics

## Key Features

### **1. Time Units in Days**
- **Default unit**: Days (not seconds)
- **Flexible units**: Days, hours, weeks
- **Decimal support**: 1.5 days = 36 hours
- **Unit conversion**: Automatic conversion to days for calculations

### **2. Standard Deviation Support**
- **Monetary costs**: Optional standard deviation for uncertainty modeling
- **Time costs**: Optional standard deviation for duration uncertainty
- **Distribution support**: Normal, lognormal, gamma, uniform distributions

### **3. Currency Support**
- **Default currency**: GBP
- **Multi-currency**: GBP, USD, EUR support
- **Consistent units**: All monetary costs in same currency

### **4. Backward Compatibility**
- **Old structure support**: `costs: { monetary: 0.50, time: 1.5 }`
- **New structure support**: `costs: { monetary: { value: 0.50, currency: "GBP" }, time: { value: 1.5, units: "days" } }`
- **Automatic detection**: Handles both formats seamlessly

## Example Usage

### **Simple Costs (No Standard Deviation)**
```json
{
  "costs": {
    "monetary": { "value": 0.50, "currency": "GBP" },
    "time": { "value": 0.1, "units": "days" }
  }
}
```

### **Complex Costs (With Standard Deviation)**
```json
{
  "costs": {
    "monetary": { 
      "value": 2.00, 
      "stdev": 0.5, 
      "distribution": "lognormal",
      "currency": "GBP" 
    },
    "time": { 
      "value": 1.5, 
      "stdev": 0.5, 
      "distribution": "lognormal",
      "units": "days" 
    }
  }
}
```

## Parameter Extraction Examples

### **New Structure Parameters**
```
e.edge-slug.costs.monetary.value: 2.00
e.edge-slug.costs.monetary.stdev: 0.5
e.edge-slug.costs.monetary.currency: GBP
e.edge-slug.costs.monetary.distribution: lognormal
e.edge-slug.costs.time.value: 1.5
e.edge-slug.costs.time.stdev: 0.5
e.edge-slug.costs.time.units: days
e.edge-slug.costs.time.distribution: lognormal
```

### **Old Structure Parameters (Backward Compatibility)**
```
e.edge-slug.costs.monetary: 2.00
e.edge-slug.costs.time: 1.5
```

## Benefits

### **1. Business-Relevant Time Units**
- **Days instead of seconds** - matches business process thinking
- **Decimal support** - 1.5 days = 36 hours
- **Flexible units** - days, hours, weeks as needed

### **2. Statistical Modeling**
- **Standard deviation** - capture uncertainty in costs
- **Distribution support** - normal, lognormal, gamma, uniform
- **Bayesian analysis** - prepare for advanced analytics

### **3. Currency Support**
- **GBP default** - matches UK business context
- **Multi-currency** - USD, EUR support for international
- **Consistent units** - all monetary costs in same currency

### **4. Backward Compatibility**
- **Existing graphs** - continue to work without changes
- **Gradual migration** - can update costs to new structure over time
- **No breaking changes** - old and new structures work together

## Testing

### **Graph Editor Testing**
1. **Create edge with simple costs** - verify UI displays correctly
2. **Add standard deviation** - verify stdev inputs work
3. **Change currency/units** - verify selectors work
4. **Change distribution** - verify distribution selectors work
5. **Clear costs** - verify clear button works

### **Apps Script Testing**
1. **Calculate costs** - verify `dagCalc()` works with new structure
2. **Calculate time** - verify time calculation in days
3. **Parameter extraction** - verify `dagGetParamTable()` works
4. **Backward compatibility** - verify old cost structure still works

## Next Steps

### **Immediate Testing**
1. **Test graph editor** - create edges with new cost structure
2. **Test Apps Script** - verify calculations work correctly
3. **Test parameter extraction** - verify parameter functions work

### **Future Enhancements**
1. **Parameter association** - link edges to canonical cost parameters
2. **Analytics integration** - Bayesian cost analysis
3. **Cost optimization** - automated cost parameter updates

This update provides a much more robust foundation for cost modeling while maintaining backward compatibility and enabling advanced statistical modeling for sophisticated users.
