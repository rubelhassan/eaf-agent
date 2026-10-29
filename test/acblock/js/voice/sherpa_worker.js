/**
 * Starts an engine worker once and resolves with it when it reports ready; other messages go to onMessage.
 * @param {string} path  relative to this folder
 */
export function loadWorker(path, onMessage) {
    let worker = null;
    let loading = null;
    const ready = () => {
        loading = loading || new Promise((resolve, reject) => {
            worker = new Worker(new URL(path, import.meta.url));
            worker.onmessage = ({ data }) => {
                if (data.type === 'ready') resolve(worker);
                else if (data.type === 'error') reject(new Error(data.message));
                else onMessage(data);
            };
            worker.onerror = (e) => reject(new Error(e.message || 'A voice engine failed to load.'));
        });
        return loading;
    };
    return { ready, post: (message) => worker?.postMessage(message) };
}
