import {chromium} from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1300,height:900}});
await pg.goto('http://127.0.0.1:47321/shots.html');await pg.waitForTimeout(500);
for(const id of ['login','pricing','dark-before','dark-after','tests','settings'])await pg.locator('#s-'+id).screenshot({path:`stage/shots/${id}.png`});
await b.close();
