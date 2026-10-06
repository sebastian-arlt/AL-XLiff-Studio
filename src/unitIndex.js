'use strict';
// Snapshot identity owns the index. A reparse after Sync/Apply/Reload obtains a
// fresh index; WeakMap does not keep evicted document sessions alive.
const indexes = new WeakMap();
function getUnitIndex(parsed) {
    if (indexes.has(parsed)) return indexes.get(parsed);
    const byId = new Map(), bySource = new Map(), byOrdinal = new Map();
    for (const unit of parsed.units || []) {
        byOrdinal.set(Number(unit.ordinal), unit);
        for (const [map, key] of [[byId, String(unit.id || '')], [bySource, String(unit.source || '')]]) {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(unit);
        }
    }
    const index = { byId, bySource, byOrdinal };
    indexes.set(parsed, index);
    return index;
}
function unitAtOrdinal(parsed, ordinal) {
    const candidate = parsed.units && parsed.units[ordinal];
    return candidate && Number(candidate.ordinal) === Number(ordinal) ? candidate : getUnitIndex(parsed).byOrdinal.get(Number(ordinal));
}
module.exports = { getUnitIndex, unitAtOrdinal };
