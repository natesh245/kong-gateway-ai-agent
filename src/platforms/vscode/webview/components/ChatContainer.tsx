import React, { useEffect, useRef } from 'react';
import { ChatMessage } from './ChatMessage';
import { WelcomeMessage } from './WelcomeMessage';

interface Message {
    role: string;
    content: string;
    className?: string;
    lastUsage?: any;
    complete?: boolean;
    cancelled?: boolean;
    startTime?: number;
    endTime?: number;
}

interface ChatContainerProps {
    messages: Message[];
    isTyping: boolean;
    statusText: string;
    onStop: () => void;
    onAction: (text: string) => void;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ 
    messages, 
    isTyping, 
    statusText, 
    onStop,
    onAction
}) => {
    const chatEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isTyping]);

    return (
        <div className="chat-container" id="chat">
            <WelcomeMessage />
            {messages.map((m, i) => (
                <ChatMessage 
                    key={i}
                    {...m}
                    onAction={onAction}
                />
            ))}
            <div ref={chatEndRef} />
        </div>
    );
};
