'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { profileDirectory, inspectPanelProfile } = require('../door/setup');
const { EXPECTED } = require('../bridge/availability');
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function sourceKind(spec) {
  if (/^(file|link):/i.test(spec)) return 'local';
  if (/^(git(?:\+[^:]+)?|github|gitlab|bitbucket|ssh):|\.git(?:#|$)/i.test(spec)) return 'git';
  if (/^(?:https?|workspace|catalog|npm):|[\\/]|[A-Za-z]:/i.test(spec)) return 'unknown';
  return /^[~^*\d<>=v]|^(latest|next|beta|alpha)$/.test(spec) ? 'registry' : 'unknown';
}
function readManifest(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('安装清单无法读取');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
/** 仅选择包名、精确版本和来源类别；不返回依赖 URL、模型设置或凭据。 */
function inspectProfile(profile, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(profile || '') || profile === '.' || profile === '..') throw new Error('配置集名称不合法');
  const directory = profileDirectory(profile, options);
  let pkg;
  try { pkg = readManifest(path.join(directory, 'package.json')); }
  catch { return { profile, exists: false, packages: [], directory, hasWebApp: false }; }
  const bundles = new Set(Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.filter(x => typeof x === 'string' && PACKAGE.test(x)) : []);
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {};
  const packages = [...new Set([...Object.keys(dependencies), ...bundles])].filter(name => PACKAGE.test(name)).map(name => {
    let version, installed = false;
    try { const manifest = readManifest(path.join(directory, 'node_modules', ...name.split('/'), 'package.json'));
      installed = manifest.name === name; if (installed && VERSION.test(manifest.version)) version = manifest.version;
    } catch {}
    const spec = typeof dependencies[name] === 'string' ? dependencies[name] : '';
    const source = spec ? sourceKind(spec) : 'runtime';
    let sourceExists;
    if (source === 'local' && spec.startsWith('file:')) sourceExists = fs.existsSync(path.resolve(directory, spec.slice(5)));
    return { name, installed, version, bundled: bundles.has(name), source, sourceExists };
  });
  return { profile, exists: true, directory, packages, hasWebApp: inspectPanelProfile(profile, options).hasWebApp };
}
function compareProfiles(source, target) {
  return [...source.packages, ...target.packages.filter(x => !source.packages.some(y => y.name === x.name))].map(item => { const other = target.packages.find(x => x.name === item.name);
    return { name: item.name, sourceVersion: item.version, targetVersion: other?.version,
      state: !source.packages.some(x => x.name === item.name) ? 'target-only' : !other?.installed ? 'missing' : item.version !== other.version ? 'different-version' : item.source !== other.source ? 'different-source' : item.bundled !== other.bundled ? 'different-bundle' : 'same' };
  }).filter(x => x.state !== 'same');
}
function installationPlan(source, target) {
  return source.packages.filter(item => item.bundled && item.installed).map(item => {
    const current = target.packages.find(x => x.name === item.name);
    const needed = !current?.installed || current.version !== item.version || !current.bundled;
    return {
    name: item.name, target: target.profile, version: item.version, source: item.source,
    needed, executable: needed && target.profile !== 'desktop' && target.exists && target.hasWebApp && item.source === 'registry' && VERSION.test(item.version || ''),
    state: item.source === 'local' ? item.sourceExists === false ? '本地来源文件已经失效' : '本地候选来源，需按原来源手工安装' : item.source === 'git' ? 'Git 来源，需核对原提交与安装方式' : item.source === 'runtime' ? '随 DSH 运行时提供，无独立注册表安装来源' : !VERSION.test(item.version || '') ? '无法确认已安装的精确版本' : '注册表来源',
    };
  });
}
function profileReport({ source, target, connection, catalog }) {
  const sourceNames = { registry: '注册表', local: '本地候选', git: 'Git', runtime: '运行时', unknown: '未知' };
  const rows = profile => profile.exists ? profile.packages.map(x => `| ${x.name} | ${x.version || '未确认'} | ${sourceNames[x.source]} | ${x.installed ? '已安装' : '未确认'} | ${x.bundled ? '清单引用' : '清单未引用'} |`).join('\n') : '配置集不存在或安装清单无法读取。';
  return ['# DSH 连接与配置诊断', '',
    `连接：${connection.connected ? '已连接' : '未连接'}；接入点：${connection.version || '未确认'}；插件能力：${connection.supported ? '支持' : '未确认或不支持'}。`,
    `身份确认：${connection.authorized ? '已通过' : '尚未通过或未使用'}；身份尚未确认时保留只读诊断，限制插件执行。`,
    `本机地址：${['127.0.0.1', 'localhost'].includes(connection.host) && Number.isInteger(connection.port) ? connection.host + ':' + connection.port : '未确认'}；连接实例：${/^[A-Za-z0-9-]{10,80}$/.test(connection.instanceId || '') ? connection.instanceId : '未确认'}。`,
    `当前运行配置集：${connection.profile || '尚未确认'}；面板自启目标：${target.profile}。`,
    '磁盘安装清单与内核实际能力分别列出；安装清单不证明内核已加载。',
    ...[source, target].flatMap(profile => ['', `## 配置集 ${profile.profile}`, '| 插件 | 精确版本 | 来源 | 磁盘安装 | 清单引用 |', '| --- | --- | --- | --- | --- |', rows(profile)]),
    '', '## 当前内核实际能力', ...(catalog.capabilities || []).map(x => `- ${String(x.id).replace(/[\r\n|`\[\]<>]/g, '')}：${x.availability?.state === 'available' ? '可用' : '当前不可用'}；提供方版本：${VERSION.test(x.provider?.version || '') ? x.provider.version : '未确认'}。`),
    catalog.capabilities?.length ? '' : '尚未取得已注册的能力。',
    '', '## 配置差异', ...compareProfiles(source, target).map(x => `- ${x.name}：${({ missing: '目标配置集缺失', 'target-only': '仅目标配置集存在', 'different-version': '版本不同', 'different-source': '来源不同', 'different-bundle': '引用清单不同' })[x.state]}。`),
    '', '## 下一步', '可在“DSH：查看插件安装说明”中查看目标、精确版本和来源。安装后需重新加载相应内核并刷新能力。',
    ...EXPECTED.filter(x => !catalog.capabilities?.some(y => y.id === x.id)).map(x => {
      const profile = connection.profile === source.profile ? source : connection.profile === target.profile ? target : undefined;
      const pkg = profile?.packages.find(y => y.name === x.package);
      return `- ${x.title}：${profile?.exists ? pkg?.installed ? '磁盘已安装，当前内核未注册此能力；检查插件开关、注册补丁和加载状态。' : '当前运行配置集缺少对应插件；查看安装说明。' : '运行配置集尚未确认；先核对所属应用和配置集，再判断安装或加载问题。'}`;
    }),
    '本结果只包含安装元数据与能力状态，没有复制模型配置、依赖 URL 或接入凭据。', '',
  ].join('\n');
}
module.exports = { PACKAGE, VERSION, inspectProfile, compareProfiles, installationPlan, profileReport, sourceKind };
