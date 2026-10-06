'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setTabIcon}=require('../src/tabIcons');
test('all Studio panels have packaged icons for light and dark themes',()=>{
    const root=path.resolve(__dirname,'..');
    for(const kind of ['dashboard','wizard','xliff','glossary','memory','ai']){
        const panel={};setTabIcon(panel,root,{Uri:{joinPath:(base,...parts)=>path.join(base,...parts)}},kind);
        for(const theme of ['light','dark'])assert.ok(fs.readFileSync(panel.iconPath[theme],'utf8').includes('<svg'));
    }
});
