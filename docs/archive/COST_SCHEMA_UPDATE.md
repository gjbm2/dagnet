# Cost Schema Update - Time in Days with Standard Deviation

## Overview

Updated the cost schema to properly handle time costs in days (not seconds) and support standard deviation and distribution parameters for both monetary and time costs.

## Key Changes

### 1. **Time Units: Days (Not Seconds)**
- **Before**: Time costs in seconds (e.g., 180 seconds)
- **After**: Time costs in days (e.g., 3.0 days)
- **Rationale**: Business processes are measured in days, not seconds
- **Support**: Integer days + decimal fractions (e.g., 1.5 days = 36 hours)

### 2. **Flattened Cost Structure**
- **Before**: Generic `costs` object with `monetary` and `time` as simple numbers
- **After**: Structured `monetary` and `time` objects with full distribution support

### 3. **Standard Deviation Support**
- **Both monetary and time costs** can now have standard deviation
- **Distribution support** for both cost types
- **Currency support** for monetary costs (GBP default)

## Updated Schema Structure

### **Graph Schema (`conversion-graph-1.0.0.json`)**

```json
{
  "Costs": {
    "type": "object",
    "properties": {
      "monetary": { "$ref": "#/$defs/MonetaryCost" },
      "time": { "$ref": "#/$defs/TimeCost" }
    }
  },
  
  "MonetaryCost": {
    "type": "object",
    "required": ["value"],
    "properties": {
      "value": { "type": "number", "minimum": 0 },
      "stdev": { "type": "number", "minimum": 0 },
      "distribution": { 
        "type": "string", 
        "enum": ["normal", "lognormal", "gamma", "uniform"],
        "default": "normal"
      },
      "currency": { 
        "type": "string", 
        "enum": ["GBP", "USD", "EUR"],
        "default": "GBP"
      }
    }
  },
  
  "TimeCost": {
    "type": "object",
    "required": ["value"],
    "properties": {
      "value": { "type": "number", "minimum": 0 },
      "stdev": { "type": "number", "minimum": 0 },
      "distribution": { 
        "type": "string", 
        "enum": ["normal", "lognormal", "gamma", "uniform"],
        "default": "lognormal"
      },
      "units": { 
        "type": "string", 
        "enum": ["days", "hours", "weeks"],
        "default": "days"
      }
    }
  }
}
```

### **Parameter Registry Schema**

```yaml
# Parameter types updated
type:
  enum: [probability, monetary_cost, time_cost, standard_deviation]

# Value structure supports both cost types
value:
  oneOf:
    - type: number  # Simple value
    - type: object  # Distribution parameters
      properties:
        value: { type: number }
        stdev: { type: number, minimum: 0 }
        distribution: { enum: [normal, lognormal, gamma, uniform] }
        currency: { enum: [GBP, USD, EUR] }  # For monetary costs
        units: { enum: [days, hours, weeks] }  # For time costs
```

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

### **Parameter Registry Examples**

#### **Monetary Cost Parameter**
```yaml
id: email-campaign-cost
name: "Email Campaign Cost"
type: monetary_cost
value:
  value: 0.05
  stdev: 0.01
  distribution: "lognormal"
  currency: "GBP"
```

#### **Time Cost Parameter**
```yaml
id: checkout-duration
name: "Checkout Duration"
type: time_cost
value:
  value: 3.0
  stdev: 0.5
  distribution: "lognormal"
  units: "days"
```

## Updated Files

### **Schema Files**
- ✅ `schema/conversion-graph-1.0.0.json` - Updated cost definitions
- ✅ `param-registry/schemas/parameter-schema.yaml` - Updated parameter types
- ✅ `param-registry/schemas/registry-schema.yaml` - Updated registry types

### **Example Files**
- ✅ `example-graph.json` - Updated with new cost structure
- ✅ `param-registry/parameters/cost/email-campaign-cost.yaml` - Updated to monetary_cost
- ✅ `param-registry/parameters/time/checkout-duration.yaml` - Updated to time_cost
- ✅ `param-registry/registry.yaml` - Updated parameter types

## Implementation Impact

### **Graph Editor Changes Needed**
1. **Edge Property Panels** - Update to show monetary/time cost fields
2. **Cost Input Components** - Support for value, stdev, distribution, currency/units
3. **Validation** - Ensure time costs are in days, monetary in GBP
4. **Parameter Association** - Link edges to monetary_cost and time_cost parameters

### **Apps Script Changes Needed**
1. **Parameter Functions** - Support for monetary_cost and time_cost types
2. **Cost Calculation** - Update to handle new cost structure
3. **Validation** - Ensure time costs are in days, monetary in GBP

### **Parameter Registry Changes Needed**
1. **GitHub API Integration** - Support for new parameter types
2. **Parameter CRUD** - Handle monetary_cost and time_cost operations
3. **Validation** - Schema validation for new cost structure

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

### **4. Parameter Registry Integration**
- **Canonical parameters** - reusable cost parameters
- **Version control** - track cost parameter changes
- **Analytics preparation** - support for Bayesian analysis

## Next Steps

### **Immediate (High Priority)**
1. **Update graph editor** - support new cost structure
2. **Update Apps Script** - handle new cost types
3. **Test validation** - ensure schema compliance

### **Medium Priority**
1. **Parameter association** - link edges to cost parameters
2. **GitHub API integration** - support new parameter types
3. **Analytics preparation** - Bayesian cost analysis

This update provides a much more robust foundation for cost modeling while maintaining simplicity for basic use cases and enabling advanced statistical modeling for sophisticated users.
