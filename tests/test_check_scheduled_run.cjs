// 检测“定时任务是否成功、失败则自动补跑”的判定逻辑。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let clock = Date.UTC(2026, 10, 15, 4, 0, 0); // 2026-11-15 04:00 UTC
class Clock extends Date { static now() { return clock; } }
const scope = vm.createContext({ window: {}, Date: Clock, console });
scope.sodium = { to_string: bytes => Buffer.from(bytes).toString('utf8') };
vm.runInContext(fs.readFileSync(path.join(__dirname, '../pages/static/github.js'), 'utf8'), scope);
const client = scope.window.githubClient;

const DEPLOY = 'on:\n  schedule:\n    - cron: \'25 19 * * *\'\n    #- cron: \'0 21 * * *\'\n';
client.branch = 'main';
client.pair = {};
client.token = 't';
client.repository = 'o/r';
client.data = { schedule: { enabled: true }, accounts: [{ id: 'a', enabled: true, status: 'ready' }] };
client.b64 = value => Buffer.from(value).toString('base64');
client.bytes = value => new Uint8Array(Buffer.from(value, 'base64'));
client.encrypt = () => 'enc';
client.id = () => 'b'.repeat(32);
client.acceptOverview = () => true;

let workflow, runs, dispatched = 0;
client.request = async (urlPath, method = 'GET') => {
  if (urlPath.startsWith('/contents/') && method === 'GET') {
    if (!workflow) throw new Error('workflow file missing');
    return { content: Buffer.from(workflow).toString('base64') };
  }
  if (urlPath.startsWith('/actions/workflows/deploy.yml/runs')) return { workflow_runs: runs };
  if (urlPath.endsWith('/dispatches') && method === 'POST') { dispatched++; return null; }
  throw new Error('unexpected request ' + urlPath);
};

function run(id, event, status, conclusion, hoursAgo) {
  return { id, event, status, conclusion, created_at: new Date(clock - hoursAgo * 3600000).toISOString() };
}

async function main() {
  const scheduleAt = client.dailyCronStart('25 19 * * *', clock);
  assert.equal(scheduleAt, Date.UTC(2026, 10, 14, 19, 25), 'cron 25 19 * * * fires at 19:25 UTC');

  // 窗口内一条记录都没有：GitHub 调度可能延迟，先不补跑。
  workflow = DEPLOY;
  runs = [];
  const beforeDelayed = dispatched;
  let info = await client.checkScheduledRun();
  assert.equal(info.kind, 'delayed', 'an empty window waits for a possibly delayed schedule');
  assert.equal(dispatched, beforeDelayed, 'delayed outcome must not dispatch a new run');

  // 超过等待期仍无任何记录 → 认定调度丢失，触发补跑。
  clock = Date.UTC(2026, 10, 15, 8, 0);
  info = await client.checkScheduledRun();
  assert.equal(info.kind, 'rerun', 'a stale empty window starts a manual rerun');
  assert.equal(info.attempts, 0, 'no previous schedule attempt counted');
  clock = Date.UTC(2026, 10, 15, 4, 0);

  // 已成功 → 不补跑。
  runs = [run(1, 'schedule', 'completed', 'success', 8)];
  assert.equal((await client.checkScheduledRun()).kind, 'ok', 'a successful schedule run needs no rerun');

  // GitHub 资源不足导致失败 → 补跑。
  runs = [run(1, 'schedule', 'completed', 'failure', 8)];
  assert.equal((await client.checkScheduledRun()).kind, 'rerun', 'a failed schedule run is retried');

  // 仍有任务在排队或运行 → 等待，不重复触发。
  runs = [run(1, 'schedule', 'completed', 'failure', 8), run(2, 'workflow_dispatch', 'in_progress', null, 1)];
  assert.equal((await client.checkScheduledRun()).kind, 'running', 'never rerun while another job is active');

  // 定时失败但白天手动跑成功 → 时长已刷上，判为 skipped 且不再补跑。
  const beforeSkip = dispatched;
  runs = [run(1, 'schedule', 'completed', 'failure', 8), run(2, 'workflow_dispatch', 'completed', 'success', 2)];
  info = await client.checkScheduledRun();
  assert.equal(info.kind, 'skipped', 'a manual success in the same cycle suppresses the rerun');
  assert.equal(dispatched, beforeSkip, 'skipped outcome must not dispatch a new run');

  // 定时时间刚过不到半小时 → 给 GitHub 排队留出时间。
  clock = Date.UTC(2026, 10, 15, 19, 40);
  runs = [];
  assert.equal((await client.checkScheduledRun()).kind, 'waiting', 'fresh schedule slots keep a grace period');

  // 自动阅读暂停 → 跳过检测。
  client.data = { schedule: { enabled: false }, accounts: [] };
  assert.equal((await client.checkScheduledRun()).kind, 'disabled', 'paused schedule skips the check');
  client.data = { schedule: { enabled: true }, accounts: [{ id: 'a', enabled: true, status: 'ready' }] };
  clock = Date.UTC(2026, 10, 15, 4, 0);

  // 无法解析 cron 时退回最近 24 小时，仍能正常判定。
  workflow = '';
  runs = [run(1, 'schedule', 'completed', 'success', 3)];
  info = await client.checkScheduledRun();
  assert.equal(info.kind, 'ok', 'fallback window still detects success');
  assert.equal(info.fallback, true, 'fallback flagged when cron is unparsable');

  // 工作流文件读取失败（权限或网络）时也不应中断检测。
  workflow = null;
  runs = [run(1, 'schedule', 'completed', 'failure', 3)];
  assert.equal((await client.checkScheduledRun()).kind, 'rerun', 'unreadable workflow still allows a rerun');

  assert.ok(dispatched >= 3, 'rerun path dispatched the reading workflow: ' + dispatched);

  // 渲染层：检测结论要能变成总览卡片里的文案与徽章。
  const nodes = new Map();
  const node = selector => {if(!nodes.has(selector))nodes.set(selector,{textContent:'',title:'',innerHTML:'',open:false,hidden:false,disabled:false,
    elements:{repository:{value:''},remember:{checked:false},token:{value:''}},classList:{toggle(){}},closest:()=>null,
    getAttribute:name=>name==='id'?selector.slice(1):null,addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},reset(){}});return nodes.get(selector);};
  const appClient={connected:false,sessionVersion:1,retryAt:0,restore:async()=>false,overview:async()=>({}),cancel:async()=>{}};
  const appScope=vm.createContext({window:{githubClient:appClient,scrollTo(){},addEventListener(){}},
    document:{querySelector:node,querySelectorAll:()=>[],visibilityState:'visible',addEventListener(){}},
    sodium:{ready:Promise.resolve()},location:{hostname:'localhost',pathname:'/'},localStorage:{getItem:()=>null},
    setTimeout:()=>1,clearTimeout(){},Date:Clock});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../pages/static/app.js'),'utf8'),appScope);
  vm.runInContext('data={schedule:{enabled:true},accounts:[{id:"a",name:"甲"}],runs:[],statistics:{days:[],today:{}},notifications:{}}',appScope);
  assert.equal(appScope.checkRunSummary(),'', 'nothing shown before the first check');
  const outcomes=[{kind:'disabled'},{kind:'ok',run:{created_at:new Date(clock).toISOString()}},
                  {kind:'running',run:{status:'queued'}},{kind:'waiting',start:clock},
                  {kind:'rerun',result:{started:['a'],skipped:[]},attempts:1,fallback:false}];
  for(const info of outcomes){
    assert.ok(appScope.checkRunMessage(info).length>0,'message for '+info.kind);
    vm.runInContext('checkRunResult='+JSON.stringify(info),appScope);
    const html=appScope.checkRunSummary();
    assert.ok(html.includes('summary-row')&&html.includes('settings-status'),'summary renders for '+info.kind);
    if(info.kind==='rerun')assert.ok(html.includes('甲')===false&&html.includes('1 个账户'),'rerun summary counts accounts');
  }
  assert.ok(appScope.header('总览').includes('检测运行'),'header exposes the check button');
  assert.ok(appScope.header('总览').includes('check-run'),'check button wired to an action');
  console.log('检查定时运行逻辑回归测试通过（补跑 ' + dispatched + ' 次）');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
