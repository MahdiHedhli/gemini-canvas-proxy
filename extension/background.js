/**
 * background.js — Service Worker
 *
 * Routes messages between the native messaging host (Python HTTP server)
 * and the content script (which relays to the Canvas iframe).
 *
 * Architecture:
 *   Native Host (Python :8765)
 *       ↕ stdio (4-byte length + JSON)
 *   This service worker
 *       ↕ chrome.tabs.sendMessage
 *   Content script (in top-level Gemini page)
 *       ↕ postMessage
 *   Canvas iframe (proxy page with free Gemini API key)
 *
 * The native host connects via chrome.runtime.connectNative().
 * Chrome starts the Python process and keeps it alive while the
 * port is open. If the Python process dies, we reconnect after 2s.
 *
 * Tab discovery: We look for any tab with "gemini" or "canvas" in
 * the URL. We also listen for page_ready messages from the content
 * script, which fires when the Canvas proxy page loads.
 */

let nativePort = null;
let requestHandlingQueue = Promise.resolve();

const CANVAS_STATE_KEY = 'canvasState';
const CHUNK_KEY_PREFIX = 'chunkBuffer:';
const CHUNK_TTL_MS = 90_000;
const CHUNK_SWEEP_ALARM = 'chunk-buffer-ttl-sweep';

function isGeminiUrl(url) {
    try {
        return new URL(url).origin === 'https://gemini.google.com';
    } catch (e) {
        return false;
    }
}

async function getCanvasState() {
    const stored = await chrome.storage.session.get(CANVAS_STATE_KEY);
    return stored[CANVAS_STATE_KEY] || { tabId: null, ready: false };
}

async function setCanvasState(tabId, ready) {
    await chrome.storage.session.set({
        [CANVAS_STATE_KEY]: { tabId, ready: Boolean(ready) }
    });
}

// ── Native messaging host connection ─────────────────────────────────────────

function connectNative() {
    if (nativePort) return;

    try {
        nativePort = chrome.runtime.connectNative('com.gemini.proxy');
        console.log('[Proxy] Connected to native host');
    } catch (e) {
        console.error('[Proxy] Failed to connect to native host:', e);
        setTimeout(connectNative, 2000);
        return;
    }

    // Messages from the Python HTTP server
    nativePort.onMessage.addListener((msg) => {
        if (msg.type === 'api_request' || msg.type === 'api_request_chunk') {
            requestHandlingQueue = requestHandlingQueue
                .then(() => handleApiRequest(msg))
                .catch((error) => {
                    console.error('[Proxy] Request handling failed:', error);
                    if (nativePort) {
                        nativePort.postMessage({
                            type: 'api_response',
                            id: msg.id,
                            error: 'Extension request handling failed'
                        });
                    }
                });
        }
    });

    // Python process died — reconnect
    nativePort.onDisconnect.addListener(() => {
        console.warn('[Proxy] Native host disconnected, reconnecting...');
        nativePort = null;
        setTimeout(connectNative, 2000);
    });
}

// ── API request forwarding ───────────────────────────────────────────────────

async function addChunk(msg) {
    if (
        !Number.isInteger(msg.total_chunks)
        || msg.total_chunks < 1
        || msg.total_chunks > 128
        || !Number.isInteger(msg.chunk_index)
        || msg.chunk_index < 0
        || msg.chunk_index >= msg.total_chunks
    ) {
        throw new Error('Invalid chunk metadata');
    }
    const key = CHUNK_KEY_PREFIX + msg.id;
    const stored = await chrome.storage.session.get(key);
    const buffer = stored[key] || {
        chunks: [],
        total: msg.total_chunks,
        updatedAt: Date.now()
    };

    if (buffer.total !== msg.total_chunks) {
        await chrome.storage.session.remove(key);
        throw new Error('Chunk count changed during transfer');
    }

    buffer.chunks[msg.chunk_index] = msg.chunk_data;
    buffer.updatedAt = Date.now();
    await chrome.storage.session.set({ [key]: buffer });
    return { key, buffer };
}

async function handleApiRequest(msg) {
    // Handle chunked payloads (>1MB native messaging limit)
    if (msg.type === 'api_request_chunk') {
        const { key, buffer: buf } = await addChunk(msg);

        // Check if all chunks received
        const received = buf.chunks.filter(c => c !== undefined).length;
        console.log(`[Proxy] Chunk ${msg.chunk_index + 1}/${msg.total_chunks} received (${received}/${buf.total})`);

        if (received < buf.total) return; // Wait for more chunks

        // All chunks received — reassemble
        const fullJson = buf.chunks.join('');
        await chrome.storage.session.remove(key);
        console.log('[Proxy] All chunks reassembled, size:', fullJson.length, 'bytes');

        try {
            msg = JSON.parse(fullJson);
        } catch (e) {
            console.error('[Proxy] Failed to parse reassembled payload:', e);
            if (nativePort) {
                nativePort.postMessage({ type: 'api_response', id: msg.id, error: 'Chunk reassembly parse failed' });
            }
            return;
        }
    }

    // Prefer a tab that completed page_ready over a passive Gemini tab.
    let canvasState = await getCanvasState();
    if (!canvasState.tabId) {
        await discoverCanvasTab();
        canvasState = await getCanvasState();
    }

    if (!canvasState.tabId) {
        const err = 'No Canvas tab found. Open gemini.google.com, paste proxy HTML in Code view, click Preview.';
        console.error('[Proxy]', err);
        if (nativePort) {
            nativePort.postMessage({ type: 'api_response', id: msg.id, error: err });
        }
        return;
    }

    // Programmatically inject content script (in case it wasn't auto-injected)
    try {
        await chrome.scripting.executeScript({
            target: { tabId: canvasState.tabId, allFrames: true },
            files: ['content_script.js']
        });
    } catch (e) {
        // Already injected or sandbox restriction — that's OK
    }

    // Forward the API request to the content script
    try {
        await chrome.tabs.sendMessage(canvasState.tabId, {
            type: 'api_request',
            id: msg.id,
            method: msg.method,
            path: msg.path,
            body: msg.body,
            headers: msg.headers || {}
        });
    } catch (err) {
        console.warn('[Proxy] Failed to send to tab:', err.message);
        if (nativePort) {
            nativePort.postMessage({
                type: 'api_response',
                id: msg.id,
                error: 'Canvas tab not responding. Make sure proxy HTML is in Canvas Preview. Error: ' + err.message
            });
        }
    }
}

// ── Canvas tab discovery ─────────────────────────────────────────────────────

async function discoverCanvasTab() {
    const existing = await getCanvasState();
    if (existing.ready && existing.tabId) {
        try {
            const tab = await chrome.tabs.get(existing.tabId);
            if (isGeminiUrl(tab.url)) return existing.tabId;
        } catch (e) {
            // The ready tab no longer exists; continue discovery.
        }
    }

    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => isGeminiUrl(candidate.url));
    if (tab) {
        await setCanvasState(tab.id, false);
        console.log('[Proxy] Found Gemini tab:', tab.id, tab.url.substring(0, 60));
        return tab.id;
    }

    console.warn('[Proxy] No Gemini tab found among', tabs.length, 'tabs');
    await setCanvasState(null, false);
    return null;
}

// ── Message listeners (from content script) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'page_ready') {
        (async () => {
            await setCanvasState(sender.tab.id, true);
            console.log('[Proxy] Canvas proxy page ready, tab:', sender.tab.id);
            if (nativePort) {
                nativePort.postMessage({ type: 'page_ready', tabId: sender.tab.id });
            }
            sendResponse({ ok: true });
        })().catch((error) => {
            console.error('[Proxy] Failed to persist ready tab:', error);
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    }

    if (message.type === 'api_response') {
        if (nativePort) {
            nativePort.postMessage({
                type: 'api_response',
                id: message.id,
                status: message.status,
                data: message.data,
                error: message.error
            });
        }
    }

    return true; // Keep message channel open for async responses
});

// ── Tab lifecycle tracking ───────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.url) return;
    (async () => {
        const state = await getCanvasState();
        if (isGeminiUrl(tab.url)) {
            if (!state.ready && !state.tabId) {
                await setCanvasState(tabId, false);
            }
        } else if (tabId === state.tabId) {
            await setCanvasState(null, false);
        }
    })().catch((error) => console.error('[Proxy] Tab update failed:', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
    (async () => {
        const state = await getCanvasState();
        if (tabId === state.tabId) {
            console.log('[Proxy] Canvas tab closed');
            await setCanvasState(null, false);
        }
    })().catch((error) => console.error('[Proxy] Tab removal failed:', error));
});

async function sweepExpiredChunks() {
    const stored = await chrome.storage.session.get(null);
    const now = Date.now();
    const expired = Object.entries(stored).filter(([key, value]) => (
        key.startsWith(CHUNK_KEY_PREFIX)
        && value
        && now - value.updatedAt >= CHUNK_TTL_MS
    ));

    if (!expired.length) return;
    await chrome.storage.session.remove(expired.map(([key]) => key));
    for (const [key] of expired) {
        const requestId = key.slice(CHUNK_KEY_PREFIX.length);
        if (nativePort) {
            nativePort.postMessage({
                type: 'api_response',
                id: requestId,
                error: 'Incomplete chunk transfer expired'
            });
        }
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHUNK_SWEEP_ALARM) {
        sweepExpiredChunks().catch((error) => {
            console.error('[Proxy] Chunk TTL sweep failed:', error);
        });
    }
});

// ── Start ────────────────────────────────────────────────────────────────────

connectNative();
discoverCanvasTab();
chrome.alarms.create(CHUNK_SWEEP_ALARM, { periodInMinutes: 0.5 });
sweepExpiredChunks().catch((error) => {
    console.error('[Proxy] Initial chunk TTL sweep failed:', error);
});
