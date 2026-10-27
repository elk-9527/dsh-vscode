/* DSH's browser module format; no Node APIs or installer run in the page. */
window.__ModuleLoader__.load({
  id: 'dsh-acp-door',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const CHANNEL = '/api';
    const MARKETPLACE = 'https://marketplace.visualstudio.com/items?itemName=Elk-ydy.dsh-acp-panel';

    /** Shared across the first-run prompt and the persistent settings section. */
    function createController(rpc) {
      let state = { data: null, editorId: '', profileId: 'default', installed: null, error: '', busy: false, prompt: false };
      let disposed = false, revision = 0;
      const listeners = new Set(), requests = new Set();
      const update = patch => {
        if (disposed) return;
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
      };
      async function call(endpoint, payload = {}) {
        const abort = new AbortController(); requests.add(abort);
        const timeout = setTimeout(() => abort.abort(), endpoint === 'install' ? 210000 : 30000);
        try {
          const result = await rpc.call(CHANNEL, 'dsh-acp-door-companion/' + endpoint, payload, abort.signal);
          if (!result.ok) throw new Error(result.error.message);
          return result.value;
        } finally { clearTimeout(timeout); requests.delete(abort); }
      }
      const selected = () => ({ editorId: state.editorId, profileId: state.profileId });
      const message = error => error?.name === 'AbortError' ? '操作等待超时，请重新检测安装状态。' : error?.message || '连接未就绪，请重新检测或从扩展市场安装。';
      async function check(token) {
        if (!state.editorId) return;
        const result = await call('check', selected());
        if (token === revision) update({ installed: result });
        return result;
      }
      const controller = {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async refresh(initial = false) {
          if (state.busy || disposed) return;
          const token = ++revision;
          update({ busy: true, error: '', installed: null });
          try {
            const data = await call('status');
            if (disposed || token !== revision) return;
            const editor = data.editors.find(item => item.id === state.editorId) || data.editors[0];
            const profile = editor?.profiles.find(item => item.id === state.profileId) || editor?.profiles[0];
            update({ data, editorId: editor?.id || '', profileId: profile?.id || 'default' });
            // A dismissed first-run notice performs no background CLI checks.
            if (initial && data.dismissed) return;
            const result = await check(token);
            if (initial && !result?.installed) update({ prompt: true });
          } catch (error) {
            update({ error: message(error) });
            if (initial && state.data && !state.data.dismissed) update({ prompt: true });
          } finally { update({ busy: false }); }
        },
        async select(editorId, profileId = 'default') {
          if (state.busy || disposed) return;
          const token = ++revision;
          update({ editorId, profileId, busy: true, error: '', installed: null });
          try { await check(token); } catch (error) { update({ error: message(error) }); }
          finally { update({ busy: false }); }
        },
        async install() {
          if (state.busy || !state.editorId || disposed) return;
          update({ busy: true, error: '' });
          try {
            const result = await call('install', { ...selected(), confirmed: true });
            update({ installed: result, data: { ...state.data, dismissed: true } });
          } catch (error) { update({ error: message(error) }); }
          finally { update({ busy: false }); }
        },
        async dismiss() {
          if (state.busy || disposed) return;
          // Closing the prompt must still work when storage or the Host fails.
          update({ busy: true, prompt: false, data: { ...state.data, dismissed: true } });
          try { await call('dismiss'); }
          catch (error) { update({ error: '本次已关闭提示，但偏好未保存，下次可能再次提示。' + message(error) }); }
          finally { update({ busy: false }); }
        },
        dispose() { disposed = true; revision++; for (const abort of requests) abort.abort(); listeners.clear(); },
      };
      return controller;
    }

    const buttonStyle = { padding: '7px 12px', borderRadius: 6, cursor: 'pointer', font: 'inherit' };
    const fieldStyle = { display: 'block', width: '100%', marginTop: 6, padding: 7, font: 'inherit' };
    function InstallPanel({ controller, modal = false }) {
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      React.useEffect(() => { if (!modal) void controller.refresh(); }, [controller, modal]);
      const editor = state.data?.editors.find(item => item.id === state.editorId);
      const empty = state.data && !state.data.editors.length;
      const installed = state.installed?.installed;
      return h('div', { style: { display: 'grid', gap: 14 } },
        h('h2', { id: modal ? 'dsh-companion-title' : undefined, style: { margin: 0, fontSize: 20 } }, 'VS Code 配套扩展'),
        h('p', { style: { margin: 0 } }, '安装 DSH ACP Panel 后，可在 VS Code 中连接本机 DSH。选择安装位置，点击后自动下载并验证。'),
        empty && h('p', { role: 'status' }, '未找到本机 VS Code。请先安装 VS Code；自定义安装可将其命令加入 PATH 后重启 DSH，或使用下方扩展市场入口。'),
        editor && h('label', null, '编辑器', h('select', {
          'aria-label': '编辑器', style: fieldStyle, value: state.editorId, disabled: state.busy,
          onChange: event => void controller.select(event.target.value),
        }, state.data.editors.map(item => h('option', { key: item.id, value: item.id }, `${item.label} · ${item.location}`)))),
        editor && h('label', null, 'VS Code 配置集', h('select', {
          'aria-label': 'VS Code 配置集', style: fieldStyle, value: state.profileId, disabled: state.busy,
          onChange: event => void controller.select(state.editorId, event.target.value),
        }, editor.profiles.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        h('div', { role: 'status', 'aria-live': 'polite' }, state.busy ? '正在检测或安装，请稍候…' : installed ? `已验证安装${state.installed.version ? `：${state.installed.version}` : ''}。在 VS Code 活动栏打开 DSH 图标即可使用。` : editor && !state.error ? state.installed ? '所选配置集中尚未安装配套扩展。' : '尚未检测安装状态，请点击重新检测。' : ''),
        state.error && h('p', { role: 'alert', style: { margin: 0 } }, state.error),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          !installed && h('button', { type: 'button', style: buttonStyle, disabled: state.busy || !editor, onClick: () => void controller.install() }, state.error ? '重试安装' : '安装配套扩展'),
          h('button', { type: 'button', style: buttonStyle, disabled: state.busy, onClick: () => void controller.refresh() }, '重新检测'),
          modal && h('button', { type: 'button', style: buttonStyle, disabled: state.busy, onClick: () => void controller.dismiss() }, installed ? '完成' : '稍后安装')),
        h('a', { href: MARKETPLACE, target: '_blank', rel: 'noopener noreferrer' }, '在扩展市场查看 DSH ACP Panel'),
        h('details', null, h('summary', null, '手动安装方式'),
          h('p', null, '在终端执行以下命令；使用命名配置集时追加 --profile "配置集名称"：'),
          h('code', { style: { overflowWrap: 'anywhere' } }, 'code --install-extension Elk-ydy.dsh-acp-panel'),
          h('p', null, '也可在 VS Code 扩展视图搜索 DSH ACP Panel 并安装。')),
        modal && h('small', null, '关闭后不再自动提示；可在 DSH 设置的“VS Code 配套扩展”中继续安装。'));
    }
    function FirstRun({ controller }) {
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const dialog = React.useRef(null);
      React.useEffect(() => {
        if (!state.prompt || !dialog.current) return;
        const element = dialog.current;
        element.showModal();
        return () => element.close();
      }, [state.prompt]);
      if (!state.prompt) return null;
      return h('dialog', {
        ref: dialog, 'aria-labelledby': 'dsh-companion-title',
        onCancel: event => { event.preventDefault(); if (!state.busy) void controller.dismiss(); },
        style: { pointerEvents: 'auto', maxWidth: 520, width: 'calc(100% - 48px)', maxHeight: '85vh', overflow: 'auto', padding: 24, borderRadius: 12, border: '1px solid GrayText', background: 'Canvas', color: 'CanvasText', font: 'inherit' },
      }, h(InstallPanel, { controller, modal: true }));
    }
    function apply(ctx) {
      // Remote DSH pages must not offer to install software on a different Host.
      if (ctx.connection.isLoopback !== true) return;
      const controller = createController(ctx.connection.rpc);
      ctx.effect(() => () => controller.dispose());
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-vscode-companion', inject: () => ({ controller }) }, FirstRun));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-vscode-companion', order: 85,
        label: () => 'VS Code 配套扩展', inject: () => ({ controller }),
      }, InstallPanel));
      void controller.refresh(true);
    }
    return { inject: ['connection', 'slots'], apply, createController, InstallPanel, FirstRun };
  },
});
