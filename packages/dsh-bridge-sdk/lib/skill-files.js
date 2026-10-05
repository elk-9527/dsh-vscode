'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash, randomUUID } = require('node:crypto');
const digest = text => createHash('sha256').update(text).digest('hex');
const error = message => { throw new Error(message); };
const inside = (file, root) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** 只操作明确技能根目录；预览与提交分离，提交核对来源和正文快照。 */
class SkillFileStore {
  constructor({ roots, now = Date.now } = {}) { this.roots = roots; this.now = now; this.plans = new Map(); }
  rootsFor(context) {
    if (context.workspaceTrusted !== true) error('技能写操作需要受信任工作区');
    if (typeof context.clientId !== 'string' || !context.clientId.trim()) error('接入点未提供客户端身份，请更新接入点');
    const roots = this.roots(context);
    return Object.fromEntries(Object.entries(roots).map(([scope, root]) => [scope, path.resolve(root)]));
  }
  checked(file, context) {
    const target = path.resolve(file), roots = this.rootsFor(context);
    const entry = Object.entries(roots).find(([, root]) => inside(target, root));
    if (!entry || path.basename(target) !== 'SKILL.md') error('技能来源只读或不在允许目录');
    // 每一级均检查链接，包含尚未创建目录的已存在祖先。
    const parts = target.slice(path.parse(target).root.length).split(path.sep);
    let current = path.parse(target).root;
    for (const part of parts) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) error('链接技能不可写'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    return { file: target, scope: entry[0] };
  }
  read(file) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 128 * 1024) error('技能正文无效或超过限制'); return fs.readFileSync(file, 'utf8'); }
  text(value) { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 128 * 1024) error('技能正文为空或超过限制'); return value; }
  enabled(content, enabled) {
    if (typeof enabled !== 'boolean') error('启用状态无效');
    const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
    if (!block) error('技能缺少 frontmatter');
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = block[1].split(/\r?\n/).filter(line => !/^disable-model-invocation:/.test(line));
    lines.push('disable-model-invocation: ' + !enabled);
    return '---' + eol + lines.join(eol) + eol + '---' + block[2];
  }
  sweep() { for (const [id, plan] of this.plans) if (plan.expires <= this.now()) this.plans.delete(id); }
  preview(input, context) {
    this.sweep(); if (this.plans.size >= 64) error('待确认操作过多');
    if (!['create', 'update', 'enabled', 'delete', 'restore'].includes(input.action)) error('技能操作无效');
    let file = input.file, restored;
    if (input.action === 'create') {
      if (typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(input.name)) error('技能名称无效');
      const root = this.rootsFor(context)[input.scope]; if (!root) error('技能目标来源无效');
      file = path.join(root, input.name, 'SKILL.md');
    }
    if (input.action === 'restore') { restored = this.trash(context).find(item => item.id === input.trashId); if (!restored) error('恢复记录不存在'); file = restored.file; }
    const location = this.checked(file, context);
    const exists = fs.existsSync(location.file);
    if (['create', 'restore'].includes(input.action) && exists) error('目标技能已存在，不会覆盖');
    if (!['create', 'restore'].includes(input.action) && !exists) error('技能已经不存在');
    const before = exists ? this.read(location.file) : '';
    const after = input.action === 'delete' ? '' : input.action === 'enabled' ? this.enabled(before, input.enabled)
      : input.action === 'restore' ? this.read(restored.trashFile) : this.text(input.content);
    if (after) {
      const frontmatter = after.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
      const name = frontmatter?.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || (input.action === 'create' && name !== input.name)) error('技能 frontmatter 名称无效');
      if (before && input.action === 'update' && name !== before.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')) error('编辑技能时不能更改名称，请新建另一技能');
    }
    const plan = { id: randomUUID(), action: input.action, ...location, before, after, expectedHash: digest(before), afterHash: digest(after),
      owner: context.clientId, cwd: path.resolve(context.cwd), expires: this.now() + 600000, restored };
    this.plans.set(plan.id, plan);
    return { planId: plan.id, action: plan.action, file: plan.file, scope: plan.scope, before, after, expectedHash: plan.expectedHash, afterHash: plan.afterHash };
  }
  backup(plan, content) {
    const directory = path.join(path.dirname(plan.file), '.trash');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink()) error('恢复目录是链接');
    const id = randomUUID(), name = `${this.now()}-${id}-SKILL.md`, trashFile = path.join(directory, name);
    fs.writeFileSync(trashFile, content, { encoding: 'utf8', flag: 'wx' });
    const metadata = { version: 1, id, file: plan.file, name, scope: plan.scope, sha256: digest(content), action: plan.action, time: new Date(this.now()).toISOString() };
    fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
    return { ...metadata, trashFile };
  }
  commit(planId, context) {
    this.sweep(); const plan = this.plans.get(planId);
    if (!plan || plan.owner !== context.clientId || plan.cwd !== path.resolve(context.cwd)) error('预览已经过期或不属于当前工作区');
    if (!context.userInitiated || !context.approved) error('技能写操作需要显式确认');
    if (context.signal?.aborted) error('操作已取消');
    this.checked(plan.file, context);
    if (plan.restored && !this.trash(context).some(item => item.id === plan.restored.id && item.sha256 === plan.restored.sha256)) error('恢复来源已经变化，请重新预览');
    const existing = fs.existsSync(plan.file);
    if (digest(existing ? this.read(plan.file) : '') !== plan.expectedHash || (['create', 'restore'].includes(plan.action) && existing)) error('技能正文已经变化，请重新预览');
    fs.mkdirSync(path.dirname(plan.file), { recursive: true }); this.checked(plan.file, context);
    const lock = plan.file + '.dsh-ide.lock', fd = fs.openSync(lock, 'wx');
    let temporary, backup;
    try {
      if (digest(fs.existsSync(plan.file) ? this.read(plan.file) : '') !== plan.expectedHash) error('技能正文已经变化，请重新预览');
      if (plan.before) backup = this.backup(plan, plan.before);
      if (plan.action === 'delete') { this.checked(plan.file, context); if (digest(this.read(plan.file)) !== plan.expectedHash) error('技能正文已经变化，请重新预览'); fs.unlinkSync(plan.file); }
      else {
        temporary = plan.file + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(temporary, plan.after, { encoding: 'utf8', flag: 'wx' });
        this.checked(plan.file, context);
        if (digest(fs.existsSync(plan.file) ? this.read(plan.file) : '') !== plan.expectedHash) error('技能正文已经变化，请重新预览');
        if (['create', 'restore'].includes(plan.action)) { fs.linkSync(temporary, plan.file); fs.unlinkSync(temporary); }
        else fs.renameSync(temporary, plan.file);
        temporary = undefined;
        if (digest(this.read(plan.file)) !== plan.afterHash) error('写入后核对失败，原内容保留在恢复目录');
      }
      this.plans.delete(planId);
      return { ok: true, action: plan.action, file: plan.file, scope: plan.scope, sha256: plan.afterHash, recoveryId: backup?.id };
    } finally { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  trash(context) {
    const records = [];
    for (const [scope, root] of Object.entries(this.rootsFor(context))) {
      if (!fs.existsSync(root)) continue;
      for (const skill of fs.readdirSync(root, { withFileTypes: true })) {
        if (!skill.isDirectory() || skill.isSymbolicLink()) continue;
        const file = path.join(root, skill.name, 'SKILL.md');
        try { this.checked(file, context); } catch { continue; }
        const directory = path.join(root, skill.name, '.trash');
        if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) continue;
        for (const name of fs.readdirSync(directory).slice(-256)) {
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
          try {
            const metadataFile = path.join(directory, name);
            if (fs.lstatSync(metadataFile).isSymbolicLink() || fs.statSync(metadataFile).size > 8192) continue;
            const item = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
            if (item.version !== 1 || item.scope !== scope || item.file !== file || item.id + '.json' !== name || path.basename(item.name) !== item.name) continue;
            const trashFile = path.join(directory, item.name);
            if (fs.lstatSync(trashFile).isSymbolicLink() || digest(this.read(trashFile)) !== item.sha256) continue;
            records.push({ ...item, trashFile, skillName: skill.name });
          } catch {}
        }
      }
    }
    return records.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 128);
  }
}
module.exports = { SkillFileStore };
