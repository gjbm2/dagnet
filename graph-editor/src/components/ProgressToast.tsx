/**
 * Progress Toast Component
 * 
 * A custom toast with visual progress bar for batch operations.
 * Uses react-hot-toast's custom() API.
 * 
 * Supports multi-line labels with detailed status information.
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
 * Supports multi-line labels (split by \n)
 */
function ProgressToastContent({ current, total, label }: ProgressToastProps) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const isComplete = current >= total;
  
  // Split label into lines for multi-line display
  const labelLines = (label || 'Processing').split('\n');
  const mainLabel = labelLines[0];
  const detailLines = labelLines.slice(1);
  
  return (
    <div className="progress-toast">
      <div className="progress-toast-header">
        <span className="progress-toast-label">
          {mainLabel}
        </span>
        <span className="progress-toast-count">
          {current}/{total}
        </span>
      </div>
      {detailLines.length > 0 && (
        <div className="progress-toast-details">
          {detailLines.map((line, i) => (
            <div key={i} className="progress-toast-detail-line">
              {line}
            </div>
          ))}
        </div>
      )}
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
 * @param label - Optional label (supports multi-line with \n)
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
 * Supports multi-line messages (split by \n)
 */
export function completeProgressToast(
  id: string,
  message: string,
  hasErrors: boolean = false
): void {
  // For multi-line messages, use custom toast to preserve formatting
  if (message.includes('\n')) {
    const lines = message.split('\n');
    toast.custom(
      () => (
        <div className={`progress-toast-complete ${hasErrors ? 'has-errors' : 'success'}`}>
          <div className="progress-toast-complete-icon">
            {hasErrors ? '⚠️' : '✅'}
          </div>
          <div className="progress-toast-complete-content">
            {lines.map((line, i) => (
              <div key={i} className={i === 0 ? 'progress-toast-complete-main' : 'progress-toast-complete-detail'}>
                {line}
              </div>
            ))}
          </div>
        </div>
      ),
      { id, duration: hasErrors ? 5000 : 4000 }
    );
  } else {
    if (hasErrors) {
      toast.error(message, { id, duration: 4000 });
    } else {
      toast.success(message, { id, duration: 3000 });
    }
  }
}

/**
 * Dismiss a progress toast
 */
export function dismissProgressToast(id: string): void {
  toast.dismiss(id);
}
