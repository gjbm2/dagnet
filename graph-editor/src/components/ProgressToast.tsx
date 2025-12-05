/**
 * Progress Toast Component
 * 
 * A custom toast with visual progress bar for batch operations.
 * Uses react-hot-toast's custom() API.
 */

import React from 'react';
import toast from 'react-hot-toast';
import './ProgressToast.css';

interface ProgressToastProps {
  current: number;
  total: number;
  label?: string;
}

/**
 * Progress toast content component
 */
function ProgressToastContent({ current, total, label }: ProgressToastProps) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const isComplete = current >= total;
  
  return (
    <div className="progress-toast">
      <div className="progress-toast-header">
        <span className="progress-toast-label">
          {label || 'Processing'}
        </span>
        <span className="progress-toast-count">
          {current}/{total}
        </span>
      </div>
      <div className="progress-toast-bar-container">
        <div 
          className={`progress-toast-bar ${isComplete ? 'complete' : ''}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Show or update a progress toast
 * 
 * @param id - Unique toast ID (reuse to update existing toast)
 * @param current - Current progress (0 to total)
 * @param total - Total items
 * @param label - Optional label (e.g., "Fetching parameters")
 */
export function showProgressToast(
  id: string,
  current: number,
  total: number,
  label?: string
): void {
  toast.custom(
    () => <ProgressToastContent current={current} total={total} label={label} />,
    { 
      id,
      duration: Infinity, // Don't auto-dismiss during progress
    }
  );
}

/**
 * Complete a progress toast with success state
 */
export function completeProgressToast(
  id: string,
  message: string,
  hasErrors: boolean = false
): void {
  if (hasErrors) {
    toast.error(message, { id, duration: 4000 });
  } else {
    toast.success(message, { id, duration: 3000 });
  }
}

/**
 * Dismiss a progress toast
 */
export function dismissProgressToast(id: string): void {
  toast.dismiss(id);
}

