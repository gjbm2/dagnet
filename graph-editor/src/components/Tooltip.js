import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
export default function Tooltip({ content, children, delay = 500, position = 'top', maxWidth = 300, className = '' }) {
    const [isVisible, setIsVisible] = useState(false);
    const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
    const timeoutRef = useRef(null);
    const triggerRef = useRef(null);
    const showTooltip = () => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
            setIsVisible(true);
        }, delay);
    };
    const hideTooltip = () => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        setIsVisible(false);
    };
    const updatePosition = () => {
        if (!triggerRef.current)
            return;
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
        const baseStyle = {
            position: 'fixed',
            left: `${tooltipPosition.x}px`,
            top: `${tooltipPosition.y}px`,
            maxWidth: `${maxWidth}px`,
            zIndex: 10000,
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
    const tooltipContent = (_jsx("div", { style: getTooltipStyle(), children: _jsx("div", { style: {
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
            }, className: className, children: content }) }));
    return (_jsxs(_Fragment, { children: [_jsx("div", { ref: triggerRef, onMouseEnter: showTooltip, onMouseLeave: hideTooltip, onMouseMove: updatePosition, style: { display: 'inline-block' }, children: children }), isVisible && ReactDOM.createPortal(tooltipContent, document.body)] }));
}
