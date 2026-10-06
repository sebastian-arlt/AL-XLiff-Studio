'use strict';
function assessStressBudgets(measurements, options = {}) {
    const maxStallMs = Number(options.maxStallMs || 5000), maxRssMB = Number(options.maxRssMB || 2048);
    const syncMaxStallMs = Number(options.syncMaxStallMs || 500);
    const phaseStallLimits = {
        'Sync + companion translation memory': syncMaxStallMs,
        'Translation paging': 100,
        'Apply draft + background maintenance': 200,
        'Quality filter + sort': 100,
        'Quality paging + query cache': 100
    };
    const exceeded = measurements.filter(item => item.heartbeatMaxStallMs > Math.min(maxStallMs, phaseStallLimits[item.name] || maxStallMs) || item.peak.rssMB > maxRssMB).map(item => item.name);
    return { maxStallMs, maxRssMB, phaseStallLimits, exceeded, ui100msCandidates: measurements.filter(item => item.heartbeatMaxStallMs > 100).map(item => item.name) };
}
module.exports = { assessStressBudgets };
