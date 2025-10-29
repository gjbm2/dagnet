import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

/**
 * Validation mode for registry ID selectors
 * - 'warning': Suggest registry IDs, allow custom values (default)
 * - 'strict': Require registry IDs, block invalid values
 * - 'none': Free-form, no validation or suggestions
 */
export type ValidationMode = 'warning' | 'strict' | 'none';

interface ValidationContextValue {
  mode: ValidationMode;
  setMode: (mode: ValidationMode) => void;
}

const ValidationContext = createContext<ValidationContextValue | null>(null);

interface ValidationProviderProps {
  children: ReactNode;
}

/**
 * Validation Context Provider
 * 
 * Manages global validation mode for parameter/context/case/node selectors.
 * Persists mode to localStorage.
 */
export function ValidationProvider({ children }: ValidationProviderProps) {
  const [mode, setMode] = useState<ValidationMode>(() => {
    // Load from localStorage on init
    const saved = localStorage.getItem('dagnet:validationMode');
    if (saved === 'warning' || saved === 'strict' || saved === 'none') {
      return saved as ValidationMode;
    }
    return 'warning'; // Default
  });

  // Save to localStorage whenever mode changes
  useEffect(() => {
    localStorage.setItem('dagnet:validationMode', mode);
  }, [mode]);

  return (
    <ValidationContext.Provider value={{ mode, setMode }}>
      {children}
    </ValidationContext.Provider>
  );
}

/**
 * Hook to access validation mode
 * 
 * @throws Error if used outside ValidationProvider
 */
export function useValidationMode(): ValidationContextValue {
  const context = useContext(ValidationContext);
  if (!context) {
    throw new Error('useValidationMode must be used within ValidationProvider');
  }
  return context;
}


