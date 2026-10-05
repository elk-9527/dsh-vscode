'use strict';
/** 回环测试模型：真实 DSH 发出 HTTP 请求，夹具返回确定的流和文件工具调用。 */
const http = require('node:http');

async function fixtureProvider({ reviewReport } = {}) {
  const requests = [];
  let reviewDelay = 100;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-compat', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
    const toolReply = body.messages?.at(-1)?.role === 'tool';
    send({ role: 'assistant' });
    if (reviewReport) {
      const report = JSON.stringify(reviewReport);
      send({ content: report.slice(0, 30) });
      await new Promise(resolve => setTimeout(resolve, reviewDelay));
      send({ content: report.slice(30) }, 'stop');
      response.end('data: [DONE]\n\n'); return;
    } else if (text.includes('COMPAT_CANCEL')) {
      send({ content: 'COMPAT_WAIT' });
      const timer = setTimeout(() => { send({}, 'stop'); response.end('data: [DONE]\n\n'); }, 30000);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    if (text.includes('COMPAT_PERMISSION ')) {
      const file = text.split('COMPAT_PERMISSION ')[1].split(/[\r\n]/)[0].trim();
      const tool = body.tools?.find((item) => item.function.name === 'write');
      const previousCall = [...(body.messages || [])].reverse().find((message) => message.tool_calls)?.tool_calls?.[0];
      const previousArgs = previousCall ? JSON.parse(previousCall.function.arguments) : {};
      if (toolReply && previousArgs.sandbox_permissions) { send({ content: 'COMPAT_PERMISSION_OK' }, 'stop'); }
      else if (!tool) send({ content: 'COMPAT_NO_WRITE_TOOL' }, 'stop');
      else {
        const args = { file_path: file, content: 'COMPAT_PERMISSION_FILE', ...(toolReply ? { sandbox_permissions: 'danger-full-access', justification: '兼容测试需要向隔离测试目录写入夹具文件。' } : {}) };
        send({ tool_calls: [{ index: 0, id: toolReply ? 'compat-write-retry' : 'compat-write-denied', type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] });
        send({}, 'tool_calls');
      }
    } else if (text.includes('COMPAT_TOOL ') && !toolReply) {
      const file = text.split('COMPAT_TOOL ')[1].split(/[\r\n]/)[0].trim();
      const tool = body.tools?.find((item) => /read.*file|file.*read|^read$/i.test(item.function.name));
      if (!tool) { send({ content: `COMPAT_NO_READ_TOOL ${body.tools?.map((item) => item.function.name).join(',')}` }, 'stop'); }
      else {
        const properties = tool.function.parameters?.properties || {};
        const key = Object.keys(properties).find((name) => /path|file/i.test(name)) || 'path';
        const args = { [key]: properties[key]?.type === 'array' ? [file] : file };
        send({ tool_calls: [{ index: 0, id: 'compat-read-1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] });
        send({}, 'tool_calls');
      }
    } else {
      send({ content: 'COMPAT_' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      send({ content: toolReply ? 'TOOL_OK' : 'OK' });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, setReviewDelay(ms) { reviewDelay = ms; },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
module.exports = { fixtureProvider };
