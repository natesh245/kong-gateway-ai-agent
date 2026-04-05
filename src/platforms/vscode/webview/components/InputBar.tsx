import React, { useState, useRef, useEffect } from 'react';

interface InputBarProps {
    onSend: (content: string) => void;
    isTyping: boolean;
    disabled?: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({ onSend, isTyping, disabled }) => {
    const [inputValue, setInputValue] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const handleSend = () => {
        if (inputValue.trim()) {
            onSend(inputValue.trim());
            setInputValue('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [inputValue]);

    return (
        <div className="chat-input-row">
            <textarea 
                id="prompt"
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={disabled ? "Initializing Kong Agent..." : (isTyping ? "Agent is processing..." : "Message Kong Agent...")}
                rows={1}
                disabled={disabled || isTyping}
            />
            <button id="send" onClick={handleSend} disabled={disabled || isTyping}>Send</button>
        </div>
    );
};
