'use strict';
/** 技能适配读取内置、运行时和文件正文，并保留来源、大小与信任限制。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-provider-'));
const file = path.join(directory, 'SKILL.md'); fs.writeFileSync(file, 'FILE_SKILL_BODY');
const bundled = { level: 'bundled', name: 'bundled-skill', description: 'Bundled skill', provider: 'builtin', modelInvocable: true };
const runtime = { level: 'runtime', name: 'runtime-skill', description: 'Runtime skill', provider: 'runtime', modelInvocable: true };
const project = { level: 'project', name: 'file-skill', description: 'Project skill', path: file, modelInvocable: true };
let provider, records = [bundled, runtime, project], definition;
const getCalls = [];
const sandbox = {
  registerProvider: require('../../packages/dsh-bridge-sdk/lib').registerProvider,
  SkillFileStore: require('../../packages/dsh-bridge-sdk/lib/skill-files').SkillFileStore, join: path.join,
  Buffer, homedir: () => directory, findProjectRoot: cwd => cwd, activeSessionCwds: () => [], customSkillDirs: [], dshHome: directory, agentsHome: directory,
  stat: fs.promises.stat, readFile: fs.promises.readFile,
  collectSkills: async () => ({ skills: records, complete: true }),
  buildPayload: skills => ({ groups: [{ key: 'fixture', title: 'Fixture', skills }] }),
  serializeRegistry: skill => ({ name: skill.name, level: skill.source, provider: skill.provider }),
  skillCtx: { skills: { get: async (name, options) => { getCalls.push({ name, options }); return definition; } } },
  ctx: { inject: (_, callback) => callback({ ideBridge: { registerProvider: value => { provider = value; } } }) },
};
vm.runInNewContext(fs.readFileSync(process.argv[2] || path.join(__dirname, 'providers/skills.txt'), 'utf8'), sandbox);
const context = { cwd: directory, workspaceTrusted: true, signal: new AbortController().signal };
const invoke = (action, input = {}, selected = context) => provider.invoke('linxin.skill-explorer.' + action, input, selected);
(async () => {
  const listed = await invoke('list'); const skills = listed.groups.flatMap(group => group.skills);
  definition = { name: bundled.name, source: 'bundled', provider: 'builtin', content: 'BUNDLED_SKILL_BODY' };
  const readBundled = await invoke('read', { skillId: skills.find(skill => skill.name === bundled.name).id });
  assert.equal(readBundled.content, 'BUNDLED_SKILL_BODY'); assert.equal(getCalls[0].options.cwd, directory); assert.equal(getCalls[0].options.signal, context.signal);
  definition = { name: runtime.name, source: 'runtime', provider: 'runtime', content: 'RUNTIME_SKILL_BODY' };
  assert.equal((await invoke('read', { skillId: skills.find(skill => skill.name === runtime.name).id })).content, 'RUNTIME_SKILL_BODY');
  const registryReads = getCalls.length;
  assert.equal((await invoke('read', { skillId: skills.find(skill => skill.name === project.name).id })).content, 'FILE_SKILL_BODY');
  assert.equal(getCalls.length, registryReads, 'File-backed skills preserve the scanned file path');
  const bundledId = skills.find(skill => skill.name === bundled.name).id;
  definition = { name: bundled.name, source: 'bundled', provider: 'changed-provider', content: 'STALE_BODY' };
  await assert.rejects(invoke('read', { skillId: bundledId }), /已经变化/);
  definition = { name: bundled.name, source: 'runtime', provider: 'builtin', content: 'WRONG_SOURCE_BODY' };
  await assert.rejects(invoke('read', { skillId: bundledId }), /已经变化/);
  definition = { name: bundled.name, source: 'bundled', provider: 'builtin', content: '界'.repeat(350000) };
  await assert.rejects(invoke('read', { skillId: bundledId }), /超过限制/);
  await assert.rejects(invoke('read', { skillId: 'not-a-listed-id' }), /已经变化/);
  const beforeRestricted = getCalls.length;
  const restricted = { ...context, workspaceTrusted: false };
  assert.equal((await invoke('list', {}, restricted)).groups[0].skills.length, 0);
  await assert.rejects(invoke('read', { skillId: bundledId }, restricted), /已经变化/); assert.equal(getCalls.length, beforeRestricted);
  records = [project]; fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(invoke('read', { skillId: skills.find(skill => skill.name === project.name).id }), /超过限制/);
  console.log('Bundled, runtime and file skill bodies, stale identities, byte limits and restricted workspace checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
