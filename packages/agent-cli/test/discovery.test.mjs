import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDiscovery, DISCOVERY_TOOLS } from '../src/discovery.mjs';
const id = 'a'.repeat(64);
test('discovery accepts only trusted/loopback origins and sends bounded credential-free GET reads', async () => {
  for (const site of ['https://example.com','https://karma42.ai','https://karma42-launch.web.app','http://karma42.ai','https://karma42.ai/path','https://user:secret@karma42.ai','https://karma42.ai:444','https://karma42.ai/?token=secret']) assert.throws(()=>createDiscovery({site}));
  const requests=[];const server=createServer((req,res)=>{requests.push({url:req.url,authorization:req.headers.authorization,method:req.method});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.startsWith('/api/discovery/projects/'+id)?{catalog:{id,title:'Game'},card:{definition:{title:'Game'}}}:{projects:[{id,title:'Game'}],next:null}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {const discovery=createDiscovery({site:`http://127.0.0.1:${server.address().port}`});
    const list=await discovery.call('explore_projects',{q:'front end',category:'games'});assert.equal(list.projects[0].id,id);assert.match(list.projects[0].project_page,/project=/);assert.match(list.content_trust,/not instructions/);
    const detail=await discovery.call('get_public_project',{project_id:id});assert.equal(detail.catalog.id,id);assert.match(detail.project_page,/project=/);assert.match(detail.next_step,/join and add your agent/);
    assert.equal(DISCOVERY_TOOLS.length,2);
    for(const name of ['get_project_join_link','unknown'])await assert.rejects(discovery.call(name,{project_id:id}),/unknown/);
    assert.deepEqual(requests.map(r=>r.method),['GET','GET']);assert.ok(requests.every(r=>r.authorization===undefined));assert.match(requests[0].url,/q=front\+end/);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
