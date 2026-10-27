'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { publicAddress, resolvePublicUrl, localImage, imageMime } = require('../src/panel/image-resources');
const { renderMarkdown } = require('../media/markdown');
const { PanelImages } = require('../src/panel/images');
const { validateImage } = require('../src/dsh/images');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=', 'base64');
(async () => {
  for (const value of ['127.0.0.1','10.1.1.1','169.254.1.1','172.16.1.1','192.168.1.1','100.64.1.1','::1','0:0:0:0:0:0:0:1','::ffff:127.0.0.1','fc00::1','fe80::1','not-ip']) assert.equal(publicAddress(value), false, value);
  for (const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(value), true, value);
  for (const source of ['http://127.0.0.1/a.png','http://user:password@example.com/a.png','file:///image.png','data:image/png;base64,YQ==']) await assert.rejects(resolvePublicUrl(source));
  await assert.rejects(resolvePublicUrl('https://example.com/a.png',{lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}));
  const resolved = await resolvePublicUrl('https://example.com/a.png',{lookup:async()=>[{address:'8.8.8.8',family:4}]});
  assert.equal(resolved.address.address,'8.8.8.8');
  const cancelled = new AbortController();
  const waiting = resolvePublicUrl('https://example.com/a.png',{lookup:()=>new Promise(()=>{}),signal:cancelled.signal}); cancelled.abort(); await assert.rejects(waiting);

  const parent=path.resolve(__dirname,'../../../build/test-runs'); await fs.mkdir(parent,{recursive:true});
  const folder=await fs.mkdtemp(path.join(parent,'image-resources-'));
  try {
    const workspace=path.join(folder,'workspace'), outside=path.join(folder,'outside'); await fs.mkdir(workspace); await fs.mkdir(outside);
    await fs.writeFile(path.join(workspace,'图片 (1).png'),PNG); await fs.writeFile(path.join(outside,'private.png'),PNG);
    const result=await localImage('图片%20(1).png',workspace); assert.equal(result.data,PNG.toString('base64'));
    assert.equal(imageMime(PNG),'image/png');
    await assert.rejects(localImage('../outside/private.png',workspace));
    await fs.symlink(outside,path.join(workspace,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(localImage('link/private.png',workspace)); await fs.unlink(path.join(workspace,'link'));
    for(const source of ['command:run','javascript:run','data:image/png,evil','//host/image.png','../outside/private.png','%00']) await assert.rejects(localImage(source,workspace));

    const posted=[], view={}; let scope={client:{isConnected:true,async request(){return{input:true,mode:'native',model:'test'}}},view,cwd:workspace,sessionId:'one',trusted:true};
    const panel=new PanelImages({root:path.join(folder,'storage'),scope:()=>scope,post:value=>posted.push(value),pick:async()=>[path.join(workspace,'图片 (1).png')],resolve:async()=>validateImage({bytes:PNG,mimeType:'image/png'})});
    await panel.handle({type:'imagePick',requestId:1}); const item=posted.at(-1).items[0]; assert(item.id.startsWith('image:')); assert(!('data' in item));
    await panel.handle({type:'imagePreview',requestId:2,item}); assert(posted.at(-1).dataUrl.startsWith('data:image/png;base64,'));
    await panel.assertInput([item]); scope.client.request=async()=>({input:false,reason:'model-does-not-declare-image'}); await assert.rejects(panel.assertInput([item]));
    scope.trusted=false; await panel.handle({type:'imageAdd',requestId:3,data:PNG.toString('base64'),mimeType:'image/png'}); assert(posted.at(-1).error);
    scope.trusted=true; await panel.incoming('assistant',{data:PNG.toString('base64'),mimeType:'image/png'}); await panel.incoming('assistant',{data:PNG.toString('base64'),mimeType:'image/png'});
    assert.equal(posted.filter(value=>value.type==='image').length,1,'duplicate assistant image is suppressed');
    assert(!JSON.stringify(posted.filter(value=>value.type==='image')).includes(PNG.toString('base64')),'transcript contains only snapshot refs');
    let finish; scope.client.request=()=>new Promise(resolve=>{finish=resolve}); const refresh=panel.refresh(); panel.reset(); finish({input:true}); await refresh;
    assert.equal(posted.at(-1).input,false,'late capability cannot override reset');
  } finally {
    assert.equal(path.dirname(await fs.realpath(folder)),await fs.realpath(parent)); await fs.rm(folder,{recursive:true,force:true});
  }
  for(const source of ['![图片](https://example.com/image.gif)','![图片](assets/image.png)','![图片](<assets/my image.png>)','[图片](assets/image.webp)','https://example.com/image.jpg']) {const html=renderMarkdown(source); assert(html.includes('chat-image-request'));assert(!html.includes('<img'));}
  for(const source of ['`![图片](assets/image.png)`','```\n![图片](assets/image.png)\n```','![图片](javascript:alert(1))','![图片](data:image/svg+xml,bad)']) assert(!renderMarkdown(source).includes('chat-image-request'));
  console.log('PASS image resources: public DNS pinning, private network rejection, cancellation, workspace boundaries, snapshots, capability gates, output deduplication and safe Markdown placeholders');
})().catch(error=>{console.error(error);process.exitCode=1});
