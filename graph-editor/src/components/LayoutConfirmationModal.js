import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function LayoutConfirmationModal({ isOpen, onConfirm, onRevert }) {
    if (!isOpen)
        return null;
    return (_jsx("div", { style: {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
        }, children: _jsxs("div", { style: {
                background: '#fff',
                borderRadius: '8px',
                padding: '24px',
                minWidth: '400px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
            }, children: [_jsx("h2", { style: {
                        margin: '0 0 16px 0',
                        fontSize: '20px',
                        fontWeight: 'bold',
                        color: '#333'
                    }, children: "Keep Layout?" }), _jsx("p", { style: {
                        margin: '0 0 24px 0',
                        fontSize: '14px',
                        color: '#666',
                        lineHeight: '1.5'
                    }, children: "The graph has been automatically laid out. Would you like to keep this layout or revert to the previous positions?" }), _jsxs("div", { style: {
                        display: 'flex',
                        gap: '12px',
                        justifyContent: 'flex-end'
                    }, children: [_jsx("button", { onClick: onRevert, style: {
                                padding: '8px 16px',
                                borderRadius: '4px',
                                border: '1px solid #ddd',
                                background: '#fff',
                                color: '#666',
                                fontSize: '14px',
                                fontWeight: '500',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }, onMouseEnter: (e) => {
                                e.currentTarget.style.background = '#f5f5f5';
                                e.currentTarget.style.borderColor = '#999';
                            }, onMouseLeave: (e) => {
                                e.currentTarget.style.background = '#fff';
                                e.currentTarget.style.borderColor = '#ddd';
                            }, children: "Revert" }), _jsx("button", { onClick: onConfirm, style: {
                                padding: '8px 16px',
                                borderRadius: '4px',
                                border: 'none',
                                background: '#007bff',
                                color: '#fff',
                                fontSize: '14px',
                                fontWeight: '500',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }, onMouseEnter: (e) => {
                                e.currentTarget.style.background = '#0056b3';
                            }, onMouseLeave: (e) => {
                                e.currentTarget.style.background = '#007bff';
                            }, children: "Keep Layout" })] })] }) }));
}
