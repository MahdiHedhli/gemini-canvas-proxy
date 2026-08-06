/**
 * content_script.js — MessageChannel Relay
 *
 * The Canvas iframe transfers one end of a MessageChannel during its ready
 * handshake. All request and response traffic then stays on that private port.
 */

let proxyPort = null;

function isChildFrame(source) {
    return Array.from(document.querySelectorAll('iframe'))
        .some((iframe) => iframe.contentWindow === source);
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'gemini-proxy-ready') return;
    if (!isChildFrame(event.source) || event.ports.length !== 1) return;

    if (proxyPort) proxyPort.close();
    proxyPort = event.ports[0];
    proxyPort.onmessage = (portEvent) => {
        const response = portEvent.data;
        if (!response || response.source !== 'gemini-proxy-response') return;
        chrome.runtime.sendMessage({
            type: 'api_response',
            id: response.id,
            status: response.status,
            data: response.data,
            error: response.error
        });
    };
    proxyPort.start();
    chrome.runtime.sendMessage({ type: 'page_ready' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'api_request' || !proxyPort) return;

    proxyPort.postMessage({
        source: 'gemini-proxy-request',
        id: message.id,
        method: message.method,
        path: message.path,
        body: message.body,
        headers: message.headers
    });
});
