import React from 'react';
import './LoadingSpinner.css';

/**
 * Loading Spinner
 * 
 * Simple loading indicator
 */
interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  message?: string;
}

export function LoadingSpinner({ size = 'medium', message }: LoadingSpinnerProps) {
  return (
    <div className={`loading-spinner loading-spinner-${size}`}>
      <div className="loading-spinner-icon" />
      {message && <div className="loading-spinner-message">{message}</div>}
    </div>
  );
}

