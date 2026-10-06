'use strict';

const { parentPort, workerData } = require('worker_threads');
const { updateTranslationUnits, parseXliff } = require('./xliff');
const { analyzeXliffQuality } = require('./quality');
const { synchronizeTranslationUnits } = require('./synchronize');
const { translationMemorySnapshots } = require('./translationMemory');

function runTask(data) {
    const task = data && data.task;
    const payload = data && data.payload ? data.payload : {};
    if (task === 'apply') return updateTranslationUnits(payload.text, payload.changes);
    if (task === 'sync') {
        const result = synchronizeTranslationUnits(payload.targetText, payload.sourceText);
        return payload.includeMemory === false ? result : { ...result, memorySnapshots: translationMemorySnapshots([payload.targetText, result.text]) };
    }
    if (task === 'parse') {
        return parseXliff(String(payload.text || ''));
    }
    if (task === 'quality') {
        return analyzeXliffQuality(payload.parsed || { units: [] }, payload.options || {});
    }
    if (task === 'qualityText') {
        const parsed = parseXliff(String(payload.text || ''));
        const overrides = new Map((Array.isArray(payload.unitOverrides) ? payload.unitOverrides : [])
            .filter(item => item && Number.isInteger(Number(item.ordinal)))
            .map(item => [Number(item.ordinal), item]));
        if (overrides.size) {
            parsed.units = parsed.units.map(unit => {
                const override = overrides.get(Number(unit.ordinal));
                if (!override) return unit;
                return {
                    ...unit,
                    target: Object.prototype.hasOwnProperty.call(override, 'target') ? String(override.target == null ? '' : override.target) : unit.target,
                    targetState: Object.prototype.hasOwnProperty.call(override, 'targetState') ? String(override.targetState || '') : unit.targetState
                };
            });
        }
        return analyzeXliffQuality(parsed, payload.options || {});
    }
    throw new Error(`Unknown XLIFF worker task: ${String(task || '')}`);
}

try {
    const result = runTask(workerData || {});
    parentPort.postMessage({ ok: true, result });
} catch (err) {
    parentPort.postMessage({
        ok: false,
        error: {
            name: err && err.name ? String(err.name) : 'Error',
            message: err && err.message ? String(err.message) : String(err),
            stack: err && err.stack ? String(err.stack) : ''
        }
    });
}
