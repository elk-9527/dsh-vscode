'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SkillFileStore } = require('../lib/skill-files');
const fixtures = path.resolve(__dirname, '../../../build/test-skill-recovery'); fs.mkdirSync(fixtures, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtures, 'recovery-'));
const context = { cwd: root, clientId: 'fixture', workspaceTrusted: true };
const store = new SkillFileStore({ roots: () => ({ project: root }) });
const content = '---\nname: fixture\n---\nInstructions\n';
const sha256 = createHash('sha256').update(content).digest('hex');
function record(skill, index, time, corrupt) {
  const directory = path.join(root, skill, '.trash'); fs.mkdirSync(directory, { recursive: true });
  const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, name = `${index}-SKILL.md`;
  const item = { version: 1, id, file: path.join(root, skill, 'SKILL.md'), name, scope: 'project', sha256, action: 'update', time: new Date(time).toISOString() };
  fs.writeFileSync(path.join(directory, `${id}.json`), corrupt === 'metadata' ? '{' : JSON.stringify(item));
  if (corrupt !== 'missing') fs.writeFileSync(path.join(directory, name), corrupt === 'digest' ? 'changed' : content);
  return id;
}
try {
  for (let i = 0; i < 300; i++) record('fixture', i, 1700000000000 + i);
  for (const position of [0, 150, 299]) {
    const newest = record('fixture', position, 1800000000000 + position);
    const result = store.trash(context); assert.equal(result.length, 128);
    assert.equal(result[0].id, newest, 'Newest valid backup survives regardless of metadata enumeration position');
    record('fixture', position, 1700000000000 + position);
  }
  const newest = record('other', 1000, 1900000000000);
  record('other', 1001, 1950000000000, 'missing'); record('other', 1002, 1950000000001, 'digest'); record('other', 1003, 1950000000002, 'metadata');
  const result = store.trash(context); assert.equal(result[0].id, newest); assert.equal(result[0].skillName, 'other');
  assert(result.every(item => ![1001, 1002, 1003].some(index => item.id.endsWith(index.toString(16).padStart(12, '0')))));
  assert.equal(new Set(result.map(item => item.id)).size, 128);
  console.log('Recovery lists: >256 mixed files, enumeration positions, global newest, malformed metadata, missing body and digest mismatch passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
