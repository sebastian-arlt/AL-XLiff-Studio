'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { getUnitIndex, unitAtOrdinal } = require('../src/unitIndex');
test('snapshot indexes preserve duplicates and refresh after reparse', () => {
 const first={units:[{ordinal:0,id:'A',source:'Same'},{ordinal:1,id:'A',source:'Same'}]};
 const index=getUnitIndex(first);assert.equal(getUnitIndex(first),index);
 assert.equal(index.byId.get('A').length,2);assert.equal(index.bySource.get('Same').length,2);
 assert.equal(unitAtOrdinal(first,1),first.units[1]);
 const next={units:[{ordinal:0,id:'B',source:'Changed'}]};
 assert.equal(getUnitIndex(next).byId.has('A'),false);assert.notEqual(getUnitIndex(next),index);
 assert.equal(unitAtOrdinal({units:[{ordinal:9,id:'Sparse'}]},9).id,'Sparse');
 assert.equal(unitAtOrdinal(next,99),undefined);
});
