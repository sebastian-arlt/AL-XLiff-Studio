'use strict';
async function changedTextRange(oldText, newText, options = {}) {
    const yieldWork = options.yieldWork || (() => new Promise(resolve => setImmediate(resolve)));
    const chunkSize = options.chunkSize || 262144;
    const large = Math.max(oldText.length, newText.length) >= 3 * 1024 * 1024;
    let prefix = 0, oldEnd = oldText.length, newEnd = newText.length, scanned = 0;
    const maxPrefix = Math.min(oldEnd, newEnd);
    while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
        prefix++;
        if (large && ++scanned % chunkSize === 0) await yieldWork();
    }
    while (oldEnd > prefix && newEnd > prefix && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
        oldEnd--; newEnd--;
        if (large && ++scanned % chunkSize === 0) await yieldWork();
    }
    return { prefix, oldEnd, newEnd };
}
module.exports = { changedTextRange };
