import React from 'react';
import { getVsCodeApi } from '../vscode-api';

interface NotificationProps {
    filename: string;
    changeType: string;
    onClose: () => void;
    onReview: (filename: string) => void;
}

export const Notification: React.FC<NotificationProps> = ({ filename, changeType, onClose, onReview }) => {
    const vscode = getVsCodeApi();
    
    if (changeType === 'deleted') {
        return (
            <div id="notification" className="notification-toast" style={{ display: 'flex' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                    <span style={{ fontSize: '12px', fontWeight: 500 }}>
                        Detected <b>deleted</b> in <b style={{ color: 'var(--accent)' }}>{filename}</b>
                    </span>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '20px', lineHeight: 1 }}>&times;</button>
                </div>
            </div>
        );
    }

    const verb = changeType === 'created' ? 'created' : 'modified';

    return (
        <div id="notification" className="notification-toast" style={{ display: 'flex' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 500 }}>
                    Detected <b>{verb}</b> in <b style={{ color: 'var(--accent)' }}>{filename}</b>
                </span>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '20px', lineHeight: 1 }}>&times;</button>
            </div>
            <button 
                id="review-btn" 
                style={{ background: 'var(--accent)', color: 'white', border: 'none', padding: '8px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600, width: '100%' }}
                onClick={() => {
                    onReview(filename);
                    onClose();
                }}
            >
                🔍 Review & Analyze Diffs
            </button>
        </div>
    );
};

interface ToastProps {
    message: string;
    onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
    return (
        <div id="toast" className="toast" style={{ display: 'flex' }}>
            <span id="toast-message">{message}</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px' }}>&times;</button>
        </div>
    );
};
