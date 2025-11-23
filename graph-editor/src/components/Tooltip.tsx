import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
  maxWidth?: number;
  className?: string;
}

export default function Tooltip({ 
  content, 
  children, 
  delay = 500, 
  position = 'top',
  maxWidth = 300,
  className = ''
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    // Don't show tooltip if a modal is open
    const hasModal = document.querySelector('.modal-overlay');
    if (hasModal) return;
    
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      // Double-check modal still not open
      const stillHasModal = document.querySelector('.modal-overlay');
      if (!stillHasModal) {
        setIsVisible(true);
      }
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };
  
  // Hide tooltip when modals open
  useEffect(() => {
    const handleModalOpen = () => {
      hideTooltip();
    };
    
    // Listen for modal overlays being added
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element && node.classList.contains('modal-overlay')) {
            handleModalOpen();
          }
        });
      });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    
    return () => {
      observer.disconnect();
    };
  }, []);

  const updatePosition = () => {
    if (!triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;

    let x = 0;
    let y = 0;

    switch (position) {
      case 'top':
        x = rect.left + rect.width / 2 + scrollX;
        y = rect.top + scrollY;
        break;
      case 'bottom':
        x = rect.left + rect.width / 2 + scrollX;
        y = rect.bottom + scrollY;
        break;
      case 'left':
        x = rect.left + scrollX;
        y = rect.top + rect.height / 2 + scrollY;
        break;
      case 'right':
        x = rect.right + scrollX;
        y = rect.top + rect.height / 2 + scrollY;
        break;
    }

    setTooltipPosition({ x, y });
  };

  useEffect(() => {
    if (isVisible) {
      updatePosition();
    }
  }, [isVisible, position]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const getTooltipStyle = () => {
    const baseStyle: React.CSSProperties = {
      position: 'fixed',
      left: `${tooltipPosition.x}px`,
      top: `${tooltipPosition.y}px`,
      maxWidth: `${maxWidth}px`,
      zIndex: 9990,
      pointerEvents: 'none',
    };

    switch (position) {
      case 'top':
        return {
          ...baseStyle,
          transform: 'translate(-50%, -100%)',
          marginBottom: '8px',
        };
      case 'bottom':
        return {
          ...baseStyle,
          transform: 'translate(-50%, 0)',
          marginTop: '8px',
        };
      case 'left':
        return {
          ...baseStyle,
          transform: 'translate(-100%, -50%)',
          marginRight: '8px',
        };
      case 'right':
        return {
          ...baseStyle,
          transform: 'translate(0, -50%)',
          marginLeft: '8px',
        };
      default:
        return baseStyle;
    }
  };

  const tooltipContent = (
    <div
      style={getTooltipStyle()}
    >
      <div
        style={{
          background: '#1a1a1a',
          color: '#ffffff',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          lineHeight: '1.4',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          border: '1px solid #333',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        className={className}
      >
        {content}
      </div>
    </div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onMouseMove={updatePosition}
        style={{ display: 'inline-block' }}
      >
        {children}
      </div>
      {isVisible && ReactDOM.createPortal(tooltipContent, document.body)}
    </>
  );
}
