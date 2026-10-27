'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ImageStore, validateImage, validateImageDescriptor, imageContentBlock,
  MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_MESSAGE_IMAGE_BYTES, IMAGE_TTL } = require('../src/dsh/images');
const { snapshotMessage, MessageQueue } = require('../src/panel/queue');
const { normalizeDraft } = require('../src/panel/drafts');
const { QueuePersistence, normalizeQueue } = require('../src/panel/queue-persistence');
const { buildPromptBlocks } = require('../src/dsh/blocks');
const { DoorClient } = require('../src/door/client');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=', 'base64');
const declaration = { bytes: PNG, mimeType: 'image/png', name: 'sample.png' };
const valid = validateImage(declaration);
const descriptor = { kind: 'image', id: `image:${valid.sha256}`, sha256: valid.sha256, name: 'sample.png', mimeType: valid.mimeType, byteLength: valid.byteLength };
const parent = path.resolve(__dirname, '../../../build/test-runs');

(async () => {
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'image-snapshots-'));
  try {
    assert.equal(valid.data, PNG.toString('base64'));
    assert.equal(valid.byteLength, PNG.length);
    assert.equal(validateImage({ data: valid.data, mimeType: 'image/png' }).sha256, valid.sha256);
    for (const [mimeType, bytes] of [['image/jpeg', Buffer.from([255,216,255,0])],
      ['image/gif', Buffer.from('GIF89a')], ['image/webp', Buffer.from('RIFF1234WEBP')]]) assert.equal(validateImage({ bytes, mimeType }).mimeType, mimeType);
    for (const malformed of [{ data: valid.data + '\n', mimeType: 'image/png' }, { data: valid.data.slice(0,-1), mimeType: 'image/png' },
      { data: 'data:image/png;base64,' + valid.data, mimeType: 'image/png' }, { bytes: PNG, mimeType: 'image/svg+xml' },
      { bytes: PNG, mimeType: 'image/jpeg' }, { bytes: Buffer.alloc(MAX_IMAGE_BYTES+1), mimeType: 'image/png' },
      { data: 'YR==', mimeType: 'image/png' }]) assert.throws(() => validateImage(malformed));

    const store = new ImageStore({ root: path.join(folder, 'store') });
    const added = await store.put(declaration);
    assert.deepEqual(added, descriptor);
    assert.deepEqual(await store.put({ ...declaration, name: 'different.png' }), { ...descriptor, name: 'different.png' });
    assert.equal((await fs.readdir(store.root)).length, 1, 'The same pixels are stored only once');
    assert.deepEqual(await new ImageStore({ root: store.root }).read(descriptor), valid, 'Metadata refs survive store reload');
    assert.throws(() => new ImageStore({ root: 'relative-store' }));
    assert.throws(() => validateImageDescriptor({ ...descriptor, id: 'image:../outside' }));
    assert.throws(() => validateImageDescriptor({ ...descriptor, byteLength: 0 }));
    assert.deepEqual(validateImageDescriptor({ ...descriptor, data: valid.data, sourcePath: '../secret', previewDataUrl: 'raw' }), descriptor);

    const message = snapshotMessage('', [{ ...descriptor, data: valid.data, uri: 'file:///arbitrary', text: 'raw' }]);
    assert.deepEqual(message.attachments, [descriptor]);
    assert(Object.isFrozen(message.attachments[0]));
    assert(!JSON.stringify(message).includes(valid.data));
    const hugeDescriptor = { ...descriptor, byteLength: MAX_IMAGE_BYTES };
    assert.equal(snapshotMessage('', [hugeDescriptor, hugeDescriptor]).attachments.length, 2);
    assert.throws(() => snapshotMessage('', [hugeDescriptor, hugeDescriptor, hugeDescriptor]), /16 MiB/);
    assert.throws(() => snapshotMessage('', Array.from({ length: MAX_IMAGE_COUNT+1 },()=>descriptor)), /4 张/);
    assert.throws(() => snapshotMessage('', [{ kind: 'content', name: 'text', text: 'x'.repeat(256*1024+1) }, descriptor]), /256 KiB/);
    assert.equal(snapshotMessage('x'.repeat(256*1024), [descriptor]).text.length, 256*1024);
    assert.equal(MAX_MESSAGE_IMAGE_BYTES, 16*1024*1024);

    const now=Date.now(), cwd=folder;
    const draft={ version:1,cwd,savedAt:now,text:'pending',attachments:[{...descriptor,data:valid.data}],recoveries:[{text:'retained',attachments:[descriptor]}] };
    const restored=normalizeDraft(draft,{cwd});
    assert.deepEqual(restored.attachments,[descriptor]);
    assert.deepEqual(restored.recoveries[0].attachments,[descriptor]);
    assert(!JSON.stringify(restored).includes(valid.data));
    assert.equal(normalizeDraft({...draft,attachments:[{...descriptor,id:'broken'}]},{cwd}),undefined,'Malformed images reject the draft instead of silently disappearing');
    assert.deepEqual(normalizeDraft(draft,{cwd,trusted:false}).attachments,[]);
    assert.equal(normalizeDraft({...draft,attachments:Array.from({length:5},()=>descriptor)},{cwd}),undefined);

    let saved;
    const queue=new MessageQueue();
    queue.add(message,{cwd,sessionId:'image-session'},'queued-image');
    await new QueuePersistence({ get:()=>saved, update:(_,value)=>{ saved=structuredClone(value); } }).save(queue);
    const recovered=normalizeQueue(saved);
    assert.deepEqual(recovered.items[0].attachments,[descriptor]);
    assert.equal(recovered.paused,true);
    assert(!JSON.stringify(saved).includes(valid.data));

    const blocks=buildPromptBlocks('What is shown?', [{...descriptor,data:valid.data}]);
    assert.deepEqual(blocks[0],{type:'image',data:valid.data,mimeType:'image/png'});
    assert.equal(blocks.at(-1).text,'What is shown?');
    assert.throws(()=>buildPromptBlocks('',[descriptor]),/编码/);
    assert.throws(()=>imageContentBlock({...descriptor,data:valid.data,sha256:'f'.repeat(64),id:'image:'+'f'.repeat(64)}),/快照/);
    assert.deepEqual(imageContentBlock({kind:'image',mimeType:'image/png',data:valid.data}),blocks[0]);

    const client=new DoorClient({host:'127.0.0.1',port:1});
    const requests=[]; client.request=async(method,params)=>{requests.push({method,params});return{stopReason:'end_turn'};};
    client.imageStore=store;
    await client.prompt('image-session','inspect',{attachments:[descriptor]});
    assert.deepEqual(requests[0].params.prompt[0],blocks[0]);
    assert.equal(descriptor.data,undefined,'Transport resolution never mutates a queued descriptor');
    client.imageStore=undefined;
    await assert.rejects(client.prompt('image-session','inspect',{attachments:[descriptor]}),/缓存不可用/);
    const abort=new AbortController();abort.abort();
    await assert.rejects(client.prompt('image-session','inspect',{attachments:[descriptor],signal:abort.signal}),/取消/);
    assert.equal(requests.length,1);

    const storedFile=path.join(store.root,descriptor.sha256+'.image');
    const corrupt=Buffer.from(PNG);corrupt[corrupt.length-1]^=1;
    await fs.writeFile(storedFile,corrupt);
    await assert.rejects(store.read(descriptor),/校验/);
    await fs.writeFile(storedFile,PNG);
    const bounded=new ImageStore({root:path.join(folder,'bounded'),maxBytes:PNG.length});
    await bounded.put(declaration);
    await assert.rejects(bounded.put({bytes:Buffer.concat([PNG,Buffer.from([1])]),mimeType:'image/png',name:'other.png'}),/容量/);
    assert.deepEqual(await bounded.read(descriptor),valid,'Quota exhaustion never evicts referenced pixels');

    const outside=path.join(folder,'outside');await fs.mkdir(outside);
    const linked=path.join(folder,'linked');
    await fs.symlink(outside,linked,process.platform==='win32'?'junction':'dir');
    await assert.rejects(new ImageStore({root:path.join(linked,'images')}).put(declaration),/链接|重定向/);
    assert.deepEqual(await fs.readdir(outside),[],'Reject redirected roots before creating their cache directory');
    await fs.unlink(linked);
    const external=path.join(outside,'external.png');await fs.writeFile(external,PNG);
    await fs.unlink(storedFile);await fs.link(external,storedFile);
    await assert.rejects(store.read(descriptor),/身份/);
    await fs.unlink(storedFile);await fs.writeFile(storedFile,PNG);

    const old=new Date(now-IMAGE_TTL-2000);await fs.utimes(storedFile,old,old);
    assert.equal(await store.prune({protectedIds:[descriptor.id]}),0);
    assert.equal(await store.prune({protectedIds:[]}),1);
    await assert.rejects(store.read(descriptor),/失效/);
    console.log('PASS image snapshots: canonical pixels, immutable content store, quotas, path/link/integrity boundaries, metadata-only draft/queue recovery, ACP blocks and transport resolution');
  } finally {
    const realParent=await fs.realpath(parent),realFolder=await fs.realpath(folder);
    assert.equal(path.dirname(realFolder),realParent);
    assert(path.basename(realFolder).startsWith('image-snapshots-'));
    await fs.rm(realFolder,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
