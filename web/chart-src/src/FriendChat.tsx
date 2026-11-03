import { useCallback, useEffect, useRef, useState } from 'react';

/** 和单个好友的一对一私信（微信式：对方离线也能发，上线后补收）。 */

interface Peer {
  id: string;
  nickname: string;
  avatar?: string;
}

interface Message {
  id: number;
  mine: boolean;
  text: string;
  created: number;
  read: boolean;
}

interface Props {
  peer: Peer;
  online?: boolean;
  onBack: () => void;
  onError?: (message: string) => void;
}

const api = <T,>(path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? '请求失败');
    return data as T;
  });

export function FriendChat({ peer, online, onBack, onError }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ messages: Message[] }>(`/api/dm?with=${encodeURIComponent(peer.id)}`);
      setMessages(data.messages);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  }, [peer.id, onError]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft('');
    try {
      await api('/api/dm', { to: peer.id, text });
      await load();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="friend-chat">
      <div className="friend-chat-head">
        <button type="button" className="link" onClick={onBack}>
          ← 返回
        </button>
        <b>{peer.nickname}</b>
        <span className={online ? 'link-dot on' : 'link-dot off'}>{online ? '在线' : '离线'}</span>
        <span className="dim friend-chat-tip">离线也能发，上线后能收到</span>
      </div>
      <div className="friend-chat-body">
        {messages.length ? (
          messages.map((message) => (
            <div className={`dm-bubble ${message.mine ? 'is-mine' : ''}`} key={message.id}>
              <div className="dm-text">{message.text}</div>
              <small className="dim">{new Date(message.created * 1000).toLocaleTimeString()}</small>
            </div>
          ))
        ) : (
          <p className="dim">还没有聊过，说点什么吧。</p>
        )}
        <div ref={endRef} />
      </div>
      <div className="chat-form">
        <textarea
          value={draft}
          rows={2}
          maxLength={1000}
          placeholder={`发给 ${peer.nickname}…（Enter 发送，Shift+Enter 换行）`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="primary" onClick={() => void send()} disabled={!draft.trim() || busy}>
          发送
        </button>
      </div>
    </div>
  );
}
