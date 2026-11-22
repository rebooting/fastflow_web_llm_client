import './style.css';
type Settings = {
    model: string;
    think: boolean;
    system_prompt: string;
    max_tokens: number | null;
    temperature: number | null;
    top_p: number | null;
};
type Usage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    active_kv_tokens?: number;
    max_kv_token_capacity?: number;
    kv_token_occupancy_rate_percentage?: number;
};
type Message = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    model?: string;
    status?: string;
    error?: string;
    usage?: Usage;
};
type Chat = {
    id: string;
    title: string;
    settings: Settings;
    messages: Message[];
    archived: boolean;
    generating: string | null;
    folder_id: string | null;
    generated_tokens: number | null;
    last_usage: Usage | null;
    last_usage_model: string | null;
};
type ChatSummary = {
    id: string;
    title: string;
    archived: boolean;
    updated_at: string;
    folder_id: string | null;
};
type Folder = { id: string; name: string };
type Preset = {
    id: string;
    name: string;
    prompt: string;
};
type StreamEvent = {
    type: string;
    chat_id?: string;
    title?: string;
    messages?: Message[];
    content?: string;
    reasoning?: string;
    model?: string;
    message?: Message;
};
const root = document.querySelector<HTMLDivElement>('#app')!;
const favoritesKey = 'local-chat.favorite-models';
function readFavorites(): Set<string> {
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(favoritesKey) || '[]');
        return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}
let favoriteModels = readFavorites();
const state: {
    chat: Chat | null;
    chats: ChatSummary[];
    defaults: Settings;
    models: string[];
    presets: Preset[];
    archived: boolean;
    drawer: boolean;
    busy: boolean;
    saving: boolean;
    search: string;
    presetId: string;
    error: string;
    modelError: string;
    nav: number;
    activeGeneration: string | null;
    folders: Folder[];
    folderId: string | null;
} = {
    chat: null, chats: [], defaults: { model: '', think: false, system_prompt: '', max_tokens: null, temperature: null, top_p: null }, models: [], presets: [], archived: false, drawer: !window.matchMedia('(max-width: 760px)').matches, busy: false, saving: false, search: '', presetId: '', error: '', modelError: '', nav: 0, activeGeneration: null, folders: [], folderId: null
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const r = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (!r.ok) {
        let detail = `Request failed (${r.status}).`;
        try {
            detail = (await r.json()).detail || detail;
        }
        catch { /* use status */ }
        throw new Error(detail);
    }
    return r.status === 204 ? undefined as T : r.json();
}
const body = (value: unknown) => JSON.stringify(value);
function showError(error: unknown) { state.error = error instanceof Error ? error.message : String(error); renderNotice(); }
function renderNotice() { const e = document.querySelector<HTMLElement>('#notice'); if (e) {
    e.hidden = !state.error;
    e.textContent = state.error;
} }
function settings() { return state.chat?.settings || state.defaults; }
function locked() { return state.busy || state.saving || !!state.chat?.generating; }
function resizeComposer(input: HTMLTextAreaElement) {
    input.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(input).maxHeight) || 236;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
function expandComposer() {
    const compact = document.querySelector<HTMLTextAreaElement>('#prompt');
    if (!compact || compact.disabled) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'expanded-composer';
    dialog.setAttribute('aria-labelledby', 'expanded-composer-title');
    dialog.innerHTML = `<div class="expanded-header"><h2 id="expanded-composer-title">Message editor</h2><button type="button" class="icon" data-close-editor aria-label="Collapse message editor">×</button></div><label class="sr-only" for="expanded-prompt">Message</label><textarea id="expanded-prompt" placeholder="Write your message"></textarea><div class="expanded-footer"><span>Enter for a new line · Ctrl or ⌘ + Enter to send</span><button type="button" class="primary" data-send-editor>Send</button></div>`;
    document.body.append(dialog);
    const editor = dialog.querySelector<HTMLTextAreaElement>('#expanded-prompt')!;
    editor.value = compact.value;
    const selectionStart = compact.selectionStart;
    const selectionEnd = compact.selectionEnd;
    let synced = false;
    let submitting = false;
    const syncDraft = () => {
        const input = document.querySelector<HTMLTextAreaElement>('#prompt');
        if (!input) return;
        input.value = editor.value;
        resizeComposer(input);
        input.focus();
        input.setSelectionRange(editor.selectionStart, editor.selectionEnd);
        synced = true;
    };
    const send = () => {
        if (submitting || !editor.value.trim()) return;
        submitting = true;
        syncDraft();
        dialog.close();
        document.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
    };
    dialog.querySelector('[data-close-editor]')!.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-send-editor]')!.addEventListener('click', send);
    editor.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
            event.preventDefault();
            send();
        }
    });
    dialog.addEventListener('close', () => {
        if (!synced) syncDraft();
        dialog.remove();
        const input = document.querySelector<HTMLTextAreaElement>('#prompt');
        if (input && !input.disabled) input.focus();
    }, { once: true });
    dialog.showModal();
    editor.focus();
    editor.setSelectionRange(selectionStart, selectionEnd);
}
function layout() {
    root.innerHTML = `<aside class="sidebar" id="sidebar"><div class="brand">Local Chat <button class="mobile-close icon" data-action="sidebar" aria-label="Close history">×</button></div><button class="new" data-action="new"><span>＋</span> New chat</button><label class="search"><span aria-hidden="true">⌕</span><input id="search" placeholder="Search chats" aria-label="Search chats" value="${esc(state.search)}"></label><div class="tabs"><button data-action="active" class="${!state.archived && !state.folderId ? 'selected' : ''}">Chats</button><button data-action="archived" class="${state.archived ? 'selected' : ''}">Archived</button></div><div class="folders-heading"><span>Folders</span><button data-action="new-folder" aria-label="Create folder" title="Create folder">＋</button></div><nav id="folders" class="folders" aria-label="Chat folders"></nav><div id="history" class="history"></div></aside>
 <main class="main"><header class="top"><button class="icon mobile-menu" data-action="sidebar" aria-label="Open history">☰</button><h1 id="title"></h1><div class="top-controls"><label class="sr-only" for="model">Model</label><select id="model" aria-label="Model"></select><button class="favorite-model" data-action="favorite-model" aria-label="Favorite selected model" aria-pressed="false" title="Favorite selected model">☆</button><button class="link retry" data-action="retry-models" title="Retry loading models" aria-label="Retry loading models">↻</button><div class="divider"></div><label class="thinking">Thinking <input type="checkbox" id="think"><span class="switch"></span><span id="think-label"></span></label><button class="settings-toggle" data-action="drawer" aria-label="Toggle chat settings" aria-expanded="${state.drawer}">☷</button></div></header><div id="notice" class="notice" role="alert" hidden></div><div id="copy-feedback" class="copy-feedback" role="status" aria-live="polite" hidden></div><div id="model-error" class="model-error" hidden></div><section id="messages" class="messages" aria-live="polite"></section><div class="composer-wrap"><div id="usage-summary" class="usage-summary" aria-live="polite"></div><form id="composer" class="composer"><label class="sr-only" for="prompt">Message</label><textarea id="prompt" rows="1" placeholder="Message your model"></textarea><button type="button" id="expand-composer" data-action="expand-composer" title="Expand message editor" aria-label="Expand message editor">⤢</button><button id="send" title="Send message" aria-label="Send message">➤</button><button type="button" id="stop" data-action="stop" title="Stop generating" aria-label="Stop generating">■</button></form><p class="hint">Enter to send · Shift + Enter for a new line</p></div></main>
 <aside class="drawer ${state.drawer ? '' : 'closed'}" id="drawer"><div class="drawer-head"><h2>Chat settings</h2><button class="icon" data-action="drawer" aria-label="Close chat settings">×</button></div><div id="settings"></div></aside>`;
    renderHistory();
    renderFolders();
    renderChat();
    renderSettings();
    renderNotice();
}
function renderHistory() {
    const el = document.querySelector<HTMLElement>('#history');
    if (!el)
        return;
    const list = state.chats.filter(c => {
        const inScope = state.archived || (state.folderId ? c.folder_id === state.folderId : !!state.search.trim() || !c.folder_id);
        return inScope && c.title.toLowerCase().includes(state.search.toLowerCase());
    });
    el.innerHTML = list.length ? list.map(c => `<div class="history-row ${state.chat?.id === c.id ? 'current' : ''}"><button class="chat-link" data-open="${esc(c.id)}"><span aria-hidden="true">▢</span><span class="chat-label"><span>${esc(c.title)}</span>${c.folder_id && (state.archived || (!state.folderId && state.search.trim())) ? `<small>${esc(state.folders.find(f => f.id === c.folder_id)?.name || 'Folder')}</small>` : ''}</span></button><details class="menu"><summary aria-label="Actions for ${esc(c.title)}">•••</summary><div class="menu-content"><button data-chat-action="rename" data-id="${esc(c.id)}">Rename</button><button data-chat-action="move" data-id="${esc(c.id)}">Move to folder</button><button data-chat-action="export" data-id="${esc(c.id)}">Export JSON</button><button data-chat-action="${c.archived ? 'restore' : 'archive'}" data-id="${esc(c.id)}">${c.archived ? 'Restore' : 'Archive'}</button><button class="danger" data-chat-action="delete" data-id="${esc(c.id)}">Delete permanently</button></div></details></div>`).join('') : `<p class="empty-history">${state.search ? 'No matching chats.' : state.archived ? 'No archived chats.' : 'Your chats will appear here.'}</p>`;
}
function renderFolders() {
    const el = document.querySelector<HTMLElement>('#folders');
    if (!el) return;
    el.innerHTML = state.folders.map(folder => `<div class="folder-row ${!state.archived && state.folderId === folder.id ? 'current' : ''}"><button class="folder-select" data-folder="${esc(folder.id)}" aria-current="${!state.archived && state.folderId === folder.id ? 'page' : 'false'}">▱ <span>${esc(folder.name)}</span></button><button class="folder-delete" data-delete-folder="${esc(folder.id)}" aria-label="Delete folder ${esc(folder.name)}" title="Delete folder">×</button></div>`).join('');
}
function folderDialog(mode: 'create' | 'move' | 'delete', folder?: Folder, current?: string | null): Promise<string | null> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'branch-dialog';
        const content = mode === 'create'
            ? '<h2>New folder</h2><label for="folder-name">Folder name</label><input id="folder-name" maxlength="100" required autofocus>'
            : mode === 'move'
                ? `<h2>Move chat</h2><label for="folder-destination">Destination</label><select id="folder-destination"><option value="">Chats (unfiled)</option>${state.folders.map(f => `<option value="${esc(f.id)}" ${f.id === current ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`
                : `<h2>Delete folder?</h2><p>Delete “${esc(folder?.name)}”? Its chats will be moved to Chats. Archived chats remain archived.</p>`;
        const label = mode === 'create' ? 'Create' : mode === 'move' ? 'Move' : 'Delete folder';
        dialog.innerHTML = `<form method="dialog">${content}<div class="dialog-actions"><button value="cancel" class="outline" formnovalidate>Cancel</button><button value="save" class="primary">${label}</button></div></form>`;
        document.body.append(dialog);
        dialog.addEventListener('close', () => {
            const input = dialog.querySelector<HTMLInputElement | HTMLSelectElement>('#folder-name, #folder-destination');
            const value = input?.value ?? '';
            const result = dialog.returnValue === 'save' ? value : null;
            dialog.remove();
            resolve(result);
        }, {once: true});
        dialog.showModal();
    });
}
function renderChat() {
    const title = document.querySelector<HTMLElement>('#title');
    if (!title)
        return;
    title.textContent = state.chat?.title || 'New chat';
    const current = settings().model;
    renderModelPicker();
    const think = document.querySelector<HTMLInputElement>('#think')!;
    think.checked = settings().think;
    think.disabled = locked() || !!state.chat?.archived;
    document.querySelector('#think-label')!.textContent = think.checked ? 'ON' : 'OFF';
    const err = document.querySelector<HTMLElement>('#model-error')!;
    err.hidden = !state.modelError;
    err.textContent = state.modelError;
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    prompt.disabled = locked() || !!state.chat?.archived;
    prompt.placeholder = state.chat?.archived ? 'Restore this chat to continue' : current ? `Message ${current}` : 'Choose a model to start';
    document.querySelector<HTMLButtonElement>('#expand-composer')!.disabled = prompt.disabled;
    document.querySelector<HTMLButtonElement>('#send')!.hidden = state.busy || !!state.chat?.generating;
    document.querySelector<HTMLButtonElement>('#send')!.disabled = state.saving || !!state.chat?.archived;
    document.querySelector<HTMLButtonElement>('#stop')!.hidden = !(state.busy || !!state.chat?.generating);
    renderMessages();
    renderUsageSummary();
}
function renderModelPicker() {
    const select = document.querySelector<HTMLSelectElement>('#model');
    const favorite = document.querySelector<HTMLButtonElement>('[data-action="favorite-model"]');
    if (!select || !favorite) return;
    const current = settings().model;
    const options = [...state.models];
    if (current && !options.includes(current))
        options.unshift(current);
    const sorted = [...options.filter(x => favoriteModels.has(x)), ...options.filter(x => !favoriteModels.has(x))];
    select.innerHTML = `<option value="">Select a model</option>` + sorted.map(x => `<option value="${esc(x)}" ${x === current ? 'selected' : ''}>${favoriteModels.has(x) ? '★ ' : ''}${esc(x)}</option>`).join('');
    select.disabled = locked() || !!state.chat?.archived;
    const isFavorite = favoriteModels.has(current);
    favorite.disabled = !current;
    favorite.textContent = isFavorite ? '★' : '☆';
    favorite.setAttribute('aria-pressed', String(isFavorite));
    favorite.setAttribute('aria-label', 'Favorite selected model');
    favorite.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
}
const thinkingState = new Map<string, boolean>();
function tokenCount(value: number | null | undefined): string {
    return value == null ? 'unavailable' : value.toLocaleString();
}
function replyUsage(message: Message): string {
    if (message.status === 'streaming') return '';
    if (!message.usage) return '<p class="reply-usage">Token usage unavailable</p>';
    const usage = message.usage;
    const cached = usage.cached_tokens == null ? '' : ` · cached ${tokenCount(usage.cached_tokens)}`;
    return `<p class="reply-usage">Prompt ${tokenCount(usage.prompt_tokens)} · output ${tokenCount(usage.completion_tokens)}${cached} tokens</p>`;
}
function renderUsageSummary() {
    const el = document.querySelector<HTMLElement>('#usage-summary');
    if (!el) return;
    const chat = state.chat;
    if (!chat) { el.textContent = ''; return; }
    const usage = chat.last_usage;
    const active = usage?.active_kv_tokens;
    const capacity = usage?.max_kv_token_capacity;
    const reported = usage?.kv_token_occupancy_rate_percentage;
    const percent = active != null && capacity != null && capacity > 0
        ? active / capacity * 100
        : reported != null && Number.isFinite(reported) && reported >= 0 ? reported : null;
    const percentText = percent == null ? null : percent > 0 && percent < 0.005
        ? '<0.01% used' : `${percent.toFixed(2)}% used`;
    const context = active != null && capacity != null
        ? `${tokenCount(active)} / ${tokenCount(capacity)} tokens${percentText ? ` (${percentText})` : ''}`
        : percentText || 'unavailable';
    const model = chat.last_usage_model || 'model not reported';
    el.textContent = `Last reported reply context (${model}): ${context} · Chat output (reported, includes thinking): ${tokenCount(chat.generated_tokens)} tokens`;
}
let copyFeedbackTimer: number | undefined;
function copyFeedback(message: string) {
    const status = document.querySelector<HTMLElement>('#copy-feedback');
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
    window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = window.setTimeout(() => { status.hidden = true; }, 3000);
}
function legacyCopy(text: string): boolean {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    const start = editable?.selectionStart;
    const end = editable?.selectionEnd;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const x = window.scrollX;
    const y = window.scrollY;
    const transcript = document.querySelector<HTMLElement>('#messages');
    const scrollTop = transcript?.scrollTop;
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('aria-hidden', 'true');
    temporary.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;';
    document.body.append(temporary);
    try {
        temporary.focus({ preventScroll: true });
        temporary.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        temporary.remove();
        if (active?.isConnected) {
            active.focus({ preventScroll: true });
            if (editable && start != null && end != null) editable.setSelectionRange(start, end);
        }
        if (selection) {
            selection.removeAllRanges();
            ranges.forEach(range => selection.addRange(range));
        }
        if (transcript && scrollTop != null) transcript.scrollTop = scrollTop;
        if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    }
}
async function copyMessage(id: string, part: 'content' | 'reasoning') {
    const message = state.chat?.messages.find(item => item.id === id);
    const text = part === 'reasoning' ? message?.reasoning : message?.content;
    if (!text) return;
    let copied = false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
    } catch { /* Try the fallback, which also works on ordinary LAN HTTP. */ }
    if (!copied) copied = legacyCopy(text);
    copyFeedback(copied ? (part === 'reasoning' ? 'Thinking copied.' : message?.role === 'user' ? 'Message copied.' : 'Answer copied.') : 'Copy failed. Select the text and copy it manually.');
}
function renderMessages() {
    const el = document.querySelector<HTMLElement>('#messages');
    if (!el)
        return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const visibleThinking = new Map<string, boolean>();
    el.querySelectorAll<HTMLDetailsElement>('details.reasoning').forEach(details => {
        if (details.dataset.messageId) visibleThinking.set(details.dataset.messageId, details.open);
    });
    const msgs = state.chat?.messages || [];
    if (!msgs.length) {
        el.innerHTML = `<div class="welcome"><div class="welcome-mark">✳</div><h2>${state.chat?.archived ? 'Archived chat' : 'Start a new chat'}</h2><p>${state.chat?.archived ? 'Restore this chat to continue.' : 'Choose a model and send a message.'}</p></div>`;
        return;
    }
    el.innerHTML = `<div class="message-list">${msgs.map(m => m.role === 'user' ? `<article class="turn user-turn"><div class="user-bubble">${esc(m.content)}</div><div class="turn-actions"><button data-copy="content" data-id="${esc(m.id)}" ${m.content ? '' : 'disabled'}>Copy message</button><button data-turn="edit" data-id="${esc(m.id)}" ${locked() || state.chat?.archived ? 'disabled' : ''}>Edit</button><button data-turn="regenerate" data-id="${esc(m.id)}" ${locked() || state.chat?.archived ? 'disabled' : ''}>↻ Regenerate</button><button data-turn="delete" data-id="${esc(m.id)}" ${locked() ? 'disabled' : ''}>Delete turn</button></div></article>` : `<article class="turn assistant-turn" data-message-id="${esc(m.id)}"><div class="assistant-meta"><span class="avatar">✳</span><strong>Assistant</strong><span>${esc(m.model || '')}</span></div>${m.reasoning ? `<details class="reasoning" data-message-id="${esc(m.id)}" ${(visibleThinking.get(m.id) ?? thinkingState.get(m.id) ?? m.status === 'streaming') ? 'open' : ''}><summary>Thinking</summary><div>${esc(m.reasoning)}</div><button class="copy-thinking" data-copy="reasoning" data-id="${esc(m.id)}">Copy thinking</button></details>` : ''}<div class="assistant-bubble">${esc(m.content || (m.status === 'streaming' ? 'Thinking…' : ''))}</div><div class="turn-actions answer-actions"><button data-copy="content" data-id="${esc(m.id)}" ${m.content ? '' : 'disabled'}>Copy answer</button></div>${replyUsage(m)}${m.status && m.status !== 'complete' ? `<p class="status">${esc(m.status === 'streaming' ? 'Generating…' : m.status)}${m.error ? ': ' + esc(m.error) : ''}</p>` : ''}</article>`).join('')}</div>`;
    if (nearBottom) el.scrollTop = el.scrollHeight;
}
function updateStreamingMessage(message: Message) {
    const list = document.querySelector<HTMLElement>('#messages');
    const article = [...(list?.querySelectorAll<HTMLElement>('.assistant-turn') || [])]
        .find(item => item.dataset.messageId === message.id);
    if (!list || !article) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const bubble = article.querySelector<HTMLElement>('.assistant-bubble')!;
    bubble.textContent = message.content || 'Thinking…';
    article.querySelector<HTMLButtonElement>('.answer-actions button')!.disabled = !message.content;
    article.querySelector<HTMLElement>('.assistant-meta span:last-child')!.textContent = message.model || '';
    if (message.reasoning) {
        let details = article.querySelector<HTMLDetailsElement>('.reasoning');
        if (!details) {
            details = document.createElement('details');
            details.className = 'reasoning';
            details.dataset.messageId = message.id;
            details.open = thinkingState.get(message.id) ?? message.status === 'streaming';
            const summary = document.createElement('summary');
            summary.textContent = 'Thinking';
            const copy = document.createElement('button');
            copy.className = 'copy-thinking';
            copy.dataset.copy = 'reasoning';
            copy.dataset.id = message.id;
            copy.textContent = 'Copy thinking';
            details.append(summary, document.createElement('div'), copy);
            bubble.before(details);
        }
        details.querySelector('div')!.textContent = message.reasoning;
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
}
function renderSettings() {
    const el = document.querySelector<HTMLElement>('#settings');
    if (!el)
        return;
    const s = settings();
    const disabled = locked() || !!state.chat?.archived;
    el.innerHTML = `<p class="drawer-caption">${state.chat ? 'Settings for this conversation' : 'Defaults for new conversations'}</p><label for="preset">System prompt</label><select id="preset" ${disabled ? 'disabled' : ''}><option value="">Choose a preset</option>${state.presets.map(p => `<option value="${esc(p.id)}" ${p.id === state.presetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><textarea id="system" rows="6" placeholder="Give your assistant context or instructions…" ${disabled ? 'disabled' : ''}>${esc(s.system_prompt)}</textarea><div class="preset-actions"><button class="outline" data-action="save-preset" ${disabled ? 'disabled' : ''}>Save as preset</button><button class="outline" data-action="edit-preset" ${!state.presetId || disabled ? 'disabled' : ''}>Edit preset</button></div><p class="subtle">Applying a preset copies its prompt into this chat. Later preset edits do not change existing chats.</p><hr><h3>Generation</h3><label for="temperature">Temperature</label><input id="temperature" type="number" min="0" max="2" step="0.1" placeholder="Model default" value="${s.temperature ?? ''}" ${disabled ? 'disabled' : ''}><label for="top_p">Top P</label><input id="top_p" type="number" min="0.01" max="1" step="0.01" placeholder="Model default" value="${s.top_p ?? ''}" ${disabled ? 'disabled' : ''}><label for="max_tokens">Max tokens</label><input id="max_tokens" type="number" min="1" step="1" placeholder="Model default" value="${s.max_tokens ?? ''}" ${disabled ? 'disabled' : ''}><p class="subtle">Leave blank to use the model default.</p>`;
}
let historyRequest = 0;
async function refreshHistory() { const request = ++historyRequest; const archived = state.archived; const chats = await api<ChatSummary[]>(`/chats?archived=${archived}`); if (request !== historyRequest || archived !== state.archived)
    return; state.chats = chats; renderHistory(); }
async function loadModels() {
    try {
        const result = await api<{
            data: {
                id: string;
            }[];
        }>('/models');
        state.models = (result.data || []).map(x => x.id).filter(Boolean);
        state.modelError = state.models.length ? '' : 'No models were returned. Check FastFlowLM and retry.';
        if (!state.defaults.model && state.models.includes('gemma4-it:12b')) {
            state.defaults.model = 'gemma4-it:12b';
            await api('/settings', { method: 'PUT', body: body(state.defaults) });
        }
    }
    catch (e) {
        state.modelError = e instanceof Error ? e.message : 'Could not load models.';
    }
    renderChat();
}
async function selectChat(id: string) {
    const nav = ++state.nav;
    try {
        const chat = await api<Chat>(`/chats/${id}`);
        if (nav !== state.nav)
            return;
        state.chat = chat;
        state.presetId = '';
        state.error = '';
        renderHistory();
        renderChat();
        renderSettings();
        renderNotice();
        document.querySelector('#sidebar')?.classList.remove('open');
    }
    catch (e) {
        showError(e);
    }
}
async function saveSettings(next: Settings) {
    if (state.saving || state.busy)
        return;
    const id = state.chat?.id;
    state.saving = true;
    renderChat();
    renderSettings();
    try {
        if (id) {
            const updated = await api<Chat>(`/chats/${id}`, { method: 'PATCH', body: body({ settings: next }) });
            if (state.chat?.id === id)
                state.chat = updated;
        }
        else {
            state.defaults = await api<Settings>('/settings', { method: 'PUT', body: body(next) });
        }
    }
    catch (e) {
        showError(e);
    }
    finally {
        state.saving = false;
        renderChat();
        renderSettings();
    }
}
async function createChat() {
    if (state.saving)
        return;
    const nav = ++state.nav;
    const draft = document.querySelector<HTMLTextAreaElement>('#prompt')?.value || '';
    state.saving = true;
    renderChat();
    try {
        const chat = await api<Chat>('/chats', { method: 'POST', body: body({ settings: state.defaults, folder_id: state.archived ? null : state.folderId }) });
        if (nav === state.nav) {
            state.chat = chat;
            state.presetId = '';
            state.archived = false;
            layout();
            const restoredPrompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
            restoredPrompt.value = draft;
            resizeComposer(restoredPrompt);
        }
        ;
        await refreshHistory();
    }
    catch (e) {
        showError(e);
    }
    finally {
        state.saving = false;
        renderChat();
        renderSettings();
    }
}
async function chatAction(action: string, id: string) {
    try {
        if (action === 'move') {
            const chat = await api<Chat>(`/chats/${id}`);
            const destination = await folderDialog('move', undefined, chat.folder_id);
            if (destination === null) return;
            const updated = await api<Chat>(`/chats/${id}`, { method: 'PATCH', body: body({ folder_id: destination || null }) });
            if (state.chat?.id === id) state.chat = updated;
        }
        else if (action === 'rename') {
            const chat = await api<Chat>(`/chats/${id}`);
            const title = window.prompt('Rename chat', chat.title);
            if (title === null)
                return;
            const updated = await api<Chat>(`/chats/${id}`, { method: 'PATCH', body: body({ title }) });
            if (state.chat?.id === id)
                state.chat = updated;
        }
        else if (action === 'export') {
            const chat = await api<Chat>(`/chats/${id}`);
            const url = URL.createObjectURL(new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${chat.title.replace(/[^\w-]+/g, '_') || 'chat'}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }
        else if (action === 'delete') {
            if (!confirm('Permanently delete this chat? This cannot be undone.'))
                return;
            await api(`/chats/${id}`, { method: 'DELETE' });
            if (state.chat?.id === id)
                state.chat = null;
        }
        else {
            await api(`/chats/${id}/${action}`, { method: 'POST' });
            if (state.chat?.id === id)
                state.chat = null;
        }
        await refreshHistory();
        renderChat();
        renderSettings();
    }
    catch (e) {
        showError(e);
    }
}
function chooseBranch(action: string, content: string): Promise<{
    content: string;
    keep_original: boolean;
} | null> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'branch-dialog';
        dialog.innerHTML = `<form method="dialog"><h2>${action === 'edit' ? 'Edit message' : 'Regenerate reply'}</h2>${action === 'edit' ? `<label for="edit-content">Message</label><textarea id="edit-content" rows="6">${esc(content)}</textarea>` : ''}<p>Keep the original chat as a separate branch, or replace this turn and all messages after it.</p><div class="dialog-actions"><button value="cancel" class="outline">Cancel</button><button value="replace" class="outline">Replace</button><button value="keep" class="primary" autofocus>Keep original</button></div></form>`;
        document.body.append(dialog);
        dialog.addEventListener('close', () => { const result = dialog.returnValue; const text = dialog.querySelector<HTMLTextAreaElement>('#edit-content')?.value ?? content; dialog.remove(); resolve(result === 'keep' || result === 'replace' ? { content: text, keep_original: result === 'keep' } : null); }, { once: true });
        dialog.showModal();
    });
}
async function turnAction(action: string, id: string) {
    if (!state.chat || locked())
        return;
    if (action === 'delete') {
        if (!confirm('Delete this turn? Later messages will be kept.'))
            return;
        try {
            state.chat = await api<Chat>(`/chats/${state.chat.id}/turns/${id}`, { method: 'DELETE' });
            renderChat();
            await refreshHistory();
        }
        catch (e) {
            showError(e);
        }
        ;
        return;
    }
    const original = state.chat.messages.find(m => m.id === id);
    const choice = await chooseBranch(action, original?.content || '');
    if (!choice)
        return;
    await generate({ action, message_id: id, ...choice });
}
async function generate(data: Record<string, unknown>) {
    if (!state.chat || locked())
        return;
    let id = state.chat.id;
    const original = id;
    const nav = state.nav;
    state.busy = true;
    state.activeGeneration = id;
    state.error = '';
    renderNotice();
    renderChat();
    renderSettings();
    try {
        const response = await fetch(`/api/chats/${id}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(data) });
        if (!response.ok) {
            let detail = `Generation failed (${response.status}).`;
            try {
                detail = (await response.json()).detail || detail;
            }
            catch { }
            throw new Error(detail);
        }
        if (!response.body)
            throw new Error('The response stream is unavailable.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let doneEvent = false;
        while (true) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                const raw = block.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
                if (!raw)
                    continue;
                const ev = JSON.parse(raw) as StreamEvent;
                if (ev.type === 'start' && ev.chat_id && ev.messages) {
                    id = ev.chat_id;
                    state.activeGeneration = id;
                    if (state.nav === nav && state.chat?.id === original) {
                        if (id !== original)
                            state.chat = await api<Chat>(`/chats/${id}`);
                        if (state.nav === nav) {
                            state.chat.messages = ev.messages;
                            state.chat.title = ev.title || state.chat.title;
                            state.chat.generating = ev.messages.at(-1)?.id || null;
                            renderChat();
                            renderHistory();
                        }
                    }
                }
                if (ev.type === 'delta' && state.chat?.id === id) {
                    const m = state.chat.messages.at(-1);
                    if (m) {
                        m.content += ev.content || '';
                        m.reasoning = (m.reasoning || '') + (ev.reasoning || '');
                        m.model = ev.model || m.model;
                        updateStreamingMessage(m);
                    }
                }
                if (ev.type === 'done') {
                    doneEvent = true;
                    if (state.chat?.id === id && ev.message) {
                        state.chat.messages[state.chat.messages.length - 1] = ev.message;
                        state.chat.generating = null;
                        const input = document.querySelector<HTMLTextAreaElement>('#prompt');
                        if (input && data.action === 'append' && ev.message.status === 'complete' && state.nav === nav && input.value.trim() === data.content) {
                            input.value = '';
                            resizeComposer(input);
                        }
                        renderMessages();
                    }
                }
            }
            if (chunk.done)
                break;
        }
        if (!doneEvent)
            throw new Error('The reply was interrupted. Its saved partial text is available in the chat.');
    }
    catch (e) {
        showError(e);
    }
    finally {
        state.busy = false;
        state.activeGeneration = null;
        try {
            const latest = await api<Chat>(`/chats/${id}`);
            if (state.chat?.id === id)
                state.chat = latest;
            await refreshHistory();
        }
        catch (e) {
            showError(e);
        }
        renderChat();
        renderSettings();
    }
}
function bind() {
    root.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const copyButton = target.closest<HTMLElement>('[data-copy]');
        if (copyButton) {
            await copyMessage(copyButton.dataset.id!, copyButton.dataset.copy as 'content' | 'reasoning');
            return;
        }
        const summary = target.closest('summary');
        const details = summary?.parentElement;
        if (details instanceof HTMLDetailsElement && details.classList.contains('reasoning') && details.dataset.messageId)
            thinkingState.set(details.dataset.messageId, !details.open);
        const removeFolder = target.closest<HTMLElement>('[data-delete-folder]');
        if (removeFolder) {
            const folder = state.folders.find(f => f.id === removeFolder.dataset.deleteFolder);
            if (!folder || await folderDialog('delete', folder) === null) return;
            try {
                await api(`/folders/${folder.id}`, { method: 'DELETE' });
                state.folders = state.folders.filter(f => f.id !== folder.id);
                if (state.folderId === folder.id) {
                    state.folderId = null;
                    document.querySelector('[data-action="active"]')?.classList.add('selected');
                }
                if (state.chat?.folder_id === folder.id) state.chat.folder_id = null;
                renderFolders();
                await refreshHistory();
            } catch (error) { showError(error); }
            return;
        }
        const folderButton = target.closest<HTMLElement>('[data-folder]');
        if (folderButton) {
            ++state.nav;
            state.folderId = folderButton.dataset.folder || null;
            state.archived = false;
            state.chat = null;
            document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('selected'));
            renderFolders(); renderChat(); renderSettings();
            try { await refreshHistory(); } catch (error) { showError(error); }
            return;
        }
        const open = target.closest<HTMLElement>('[data-open]');
        if (open) {
            await selectChat(open.dataset.open!);
            return;
        }
        const ch = target.closest<HTMLElement>('[data-chat-action]');
        if (ch) {
            await chatAction(ch.dataset.chatAction!, ch.dataset.id!);
            return;
        }
        const turn = target.closest<HTMLElement>('[data-turn]');
        if (turn) {
            await turnAction(turn.dataset.turn!, turn.dataset.id!);
            return;
        }
        const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
        if (!action)
            return;
        if (action === 'drawer') {
            state.drawer = !state.drawer;
            document.querySelector('#drawer')?.classList.toggle('closed', !state.drawer);
            document.querySelector('[data-action="drawer"]')?.setAttribute('aria-expanded', String(state.drawer));
        }
        else if (action === 'sidebar')
            document.querySelector('#sidebar')?.classList.toggle('open');
        else if (action === 'new')
            await createChat();
        else if (action === 'expand-composer')
            expandComposer();
        else if (action === 'new-folder') {
            const name = await folderDialog('create');
            if (name === null) return;
            try {
                const folder = await api<Folder>('/folders', {method: 'POST', body: body({name})});
                state.folders.push(folder);
                state.folders.sort((a, b) => a.name.localeCompare(b.name));
                state.folderId = folder.id;
                state.archived = false;
                state.chat = null;
                ++state.nav;
                document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('selected'));
                renderFolders(); await refreshHistory(); renderChat(); renderSettings();
            } catch (error) { showError(error); }
        }
        else if (action === 'active' || action === 'archived') {
            state.archived = action === 'archived';
            state.folderId = null;
            state.chat = null;
            ++state.nav;
            document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('selected'));
            target.classList.add('selected');
            renderFolders(); renderChat(); renderSettings();
            try {
                await refreshHistory();
            }
            catch (e) {
                showError(e);
            }
        }
        else if (action === 'favorite-model') {
            const model = settings().model;
            if (!model) return;
            if (favoriteModels.has(model)) favoriteModels.delete(model);
            else favoriteModels.add(model);
            try {
                localStorage.setItem(favoritesKey, JSON.stringify([...favoriteModels]));
            } catch {
                showError('This browser could not save your model favorites. They will last only for this page session.');
            }
            renderModelPicker();
        }
        else if (action === 'retry-models')
            await loadModels();
        else if (action === 'stop') {
            const generatingId = state.activeGeneration || (state.chat?.generating ? state.chat.id : null);
            if (generatingId)
                try {
                    await api(`/chats/${generatingId}/cancel`, { method: 'POST' });
                    if (!state.activeGeneration) {
                        for (let attempt = 0; attempt < 20; attempt++) {
                            await new Promise(resolve => setTimeout(resolve, 250));
                            const chat = await api<Chat>(`/chats/${generatingId}`);
                            if (state.chat?.id === generatingId) { state.chat = chat; renderChat(); renderSettings(); }
                            if (!chat.generating) break;
                        }
                    }
                }
                catch (e) {
                    showError(e);
                }
        }
        else if (action === 'save-preset') {
            const name = prompt('Name this preset');
            if (!name?.trim())
                return;
            try {
                const p = await api<Preset>('/presets', { method: 'POST', body: body({ name, prompt: settings().system_prompt }) });
                state.presets.push(p);
                state.presetId = p.id;
                renderSettings();
            }
            catch (e) {
                showError(e);
            }
        }
        else if (action === 'edit-preset') {
            const p = state.presets.find(p => p.id === state.presetId);
            if (!p)
                return;
            const name = prompt('Preset name', p.name);
            if (name === null)
                return;
            const text = prompt('Preset prompt', p.prompt);
            if (text === null)
                return;
            try {
                const updated = await api<Preset>(`/presets/${p.id}`, { method: 'PUT', body: body({ name, prompt: text }) });
                state.presets = state.presets.map(x => x.id === p.id ? updated : x);
                renderSettings();
            }
            catch (e) {
                showError(e);
            }
        }
    });
    root.addEventListener('input', e => { const el = e.target as HTMLInputElement; if (el.id === 'search') {
        state.search = el.value;
        renderHistory();
    } else if (el instanceof HTMLTextAreaElement && el.id === 'prompt') resizeComposer(el); });
    root.addEventListener('change', async (e) => {
        const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const s = { ...settings() };
        if (el.id === 'model')
            s.model = el.value;
        else if (el.id === 'think')
            s.think = (el as HTMLInputElement).checked;
        else if (el.id === 'system')
            s.system_prompt = el.value;
        else if (el.id === 'preset') {
            state.presetId = el.value;
            const p = state.presets.find(p => p.id === el.value);
            if (!p) {
                renderSettings();
                return;
            }
            s.system_prompt = p.prompt;
        }
        else if (['temperature', 'top_p', 'max_tokens'].includes(el.id)) {
            if (!el.checkValidity()) {
                el.reportValidity();
                return;
            }
            s[el.id as 'temperature' | 'top_p' | 'max_tokens'] = el.value === '' ? null : Number(el.value);
        }
        else
            return;
        await saveSettings(s);
    });
    root.addEventListener('submit', async (e) => { if ((e.target as HTMLElement).id !== 'composer')
        return; e.preventDefault(); const input = document.querySelector<HTMLTextAreaElement>('#prompt')!; const content = input.value.trim(); if (!content)
        return; if (!state.chat) {
        await createChat();
        if (!state.chat)
            return;
    } await generate({ action: 'append', content }); });
    root.addEventListener('keydown', e => { const event = e as KeyboardEvent; if ((event.target as HTMLElement).id === 'prompt' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        document.querySelector<HTMLFormElement>('#composer')?.requestSubmit();
    } });
}
async function init() { layout(); bind(); try {
    const [defaults, presets, folders] = await Promise.all([api<Settings>('/settings'), api<Preset[]>('/presets'), api<Folder[]>('/folders')]);
    state.defaults = defaults;
    state.presets = presets;
    state.folders = folders;
    renderFolders();
    await refreshHistory();
    renderChat();
    renderSettings();
    void loadModels();
}
catch (e) {
    showError(e);
} }
void init();
