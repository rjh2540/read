// 页面直接修改“每天执行阅读时间”的读取、换算与写回测试。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const scope = vm.createContext({ window: {}, Date, console });
scope.sodium = { to_string: bytes => Buffer.from(bytes).toString('utf8'), from_string: text => Buffer.from(text, 'utf8') };
vm.runInContext(fs.readFileSync(path.join(__dirname, '../pages/static/github.js'), 'utf8'), scope);
const client = scope.window.githubClient;

const FILE = path.join(__dirname, '../.github/workflows/deploy.yml');
const REAL = fs.readFileSync(FILE, 'utf8');
// 构造一份含 CRLF 与多个被注释时段的样例，贴近真实 deploy.yml。
const FIXTURE = "name: wxread\n" +
  "on:\n" +
  "  schedule:\n" +
  "    # 凌晨任务：北京时间每天 03:25（UTC 前一天 19:25），避开整点高峰\n" +
  "    - cron: '25 19 * * *'\n" +
  "    # 早间任务\n" +
  "    #- cron: '0 21 * * *'\n" +
  "    #- cron: '40 3 * * *'\n" +
  "  workflow_dispatch:\n";

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
let current, writes;
function use(text) { current = text; writes = []; }
client.branch = 'main';
client.b64 = value => Buffer.from(value).toString('base64');
client.bytes = value => Buffer.from(value, 'base64');
client.request = async (urlPath, method = 'GET', body) => {
  if (method === 'GET') return { content: b64(current), sha: 'sha-1' };
  writes.push(body); current = Buffer.from(body.content, 'base64').toString('utf8'); return null;
};

async function main() {
  // 真实 deploy.yml：只校验能解析出生效时段且换算为合法北京时间，具体时刻随用户设置变化不钉死。
  use(REAL);
  const real = await client.loadSchedule(true);
  assert.equal(real.supported, true, '每天固定时刻可换算');
  assert.equal(real.active, true, '存在未注释的生效时段');
  assert.ok(Number.isInteger(real.hour) && real.hour >= 0 && real.hour <= 23, '解析出合法北京时间小时');
  assert.ok(Number.isInteger(real.minute) && real.minute >= 0 && real.minute <= 59, '解析出合法北京时间分钟');

  // 逐行识别：只有一个生效时段，其余注释时段都算进 rows 但不算 active。
  use(FIXTURE);
  assert.equal(client.scheduleRows(FIXTURE).length, 3, '识别出 1 个生效 + 2 个注释时段');
  assert.equal(client.scheduleRows(FIXTURE).filter(r => !r.comment).length, 1, '只有一个生效时段');

  // 改成北京时间 08:00 → 应写成 UTC 0 0，并且只改那一行、两个注释时段原样保留。
  const saved = await client.saveSchedule({ hour: 8, minute: 0 });
  assert.equal(saved.changed, true);
  assert.equal(saved.activated, false, '原本就有生效时段，不算新启用');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, 'main');
  assert.equal(writes[0].sha, 'sha-1', '带文件版本号避免覆盖他人改动');
  assert.ok(current.includes("    - cron: '0 0 * * *'"), '生效时段改写为 UTC 0 0');
  assert.ok(current.includes("#- cron: '0 21 * * *'"), '第一个注释时段原样保留');
  assert.ok(current.includes("#- cron: '40 3 * * *'"), '第二个注释时段原样保留');
  assert.equal(client.scheduleRows(current).filter(r => !r.comment).length, 1, '仍然只有一个生效时段');
  assert.ok(current.includes('北京时间每天 08:00（UTC 00:00）'), '上方说明注释同步为北京时间');
  assert.ok(current.includes('凌晨任务'), '说明注释里的原有文字未被抹掉');
  assert.ok(current.includes('避开整点高峰'), '说明注释末尾文字保留');

  // 时间未变不应重复提交。
  const before = writes.length;
  const same = await client.saveSchedule({ hour: 8, minute: 0 });
  assert.equal(same.changed, false);
  assert.equal(writes.length, before, '无变化不产生新提交');

  // 凌晨时间换算跨到前一天，注释应标注“前一天”。
  await client.saveSchedule({ hour: 3, minute: 30 });
  assert.ok(current.includes("- cron: '30 19 * * *'"), '北京时间 03:30 = UTC 前一天 19:30');
  assert.ok(current.includes('UTC 19:30，前一天'), '说明注明换算到前一天');

  // CRLF 行尾要保留，不能整份换成 LF 造成全文件 diff。
  use(FIXTURE.replace(/\n/g, '\r\n'));
  await client.saveSchedule({ hour: 12, minute: 0 });
  assert.ok(current.includes("- cron: '0 4 * * *'\r\n"), '写回保留 CRLF 行尾');

  // 全部时段都被注释：保存应启用第一个并给出 activated 提示。
  use("on:\n  schedule:\n    #- cron: '25 19 * * *'\n  workflow_dispatch:\n");
  const allCommented = await client.loadSchedule(true);
  assert.equal(allCommented.active, false, '无生效时段');
  assert.equal(allCommented.hour, 3, '仍按注释时段换算出北京时间供显示');
  const enable = await client.saveSchedule({ hour: 9, minute: 0 });
  assert.equal(enable.activated, true, '保存时启用被注释的时段');
  assert.ok(/^\s*- cron: '0 1 \* \* \*'$/m.test(current), '注释被去掉并写入新时段');
  assert.ok(!/^\s*#\s*- cron:/m.test(current), '不再残留注释时段');

  // 复杂写法（每半小时）无法安全换算：读取标记不支持，保存直接拒绝，且绝不改动文件。
  const complexText = "on:\n  schedule:\n    - cron: '*/30 * * * *'\n";
  use(complexText);
  const complex = await client.loadSchedule(true);
  assert.equal(complex.supported, false, '非每天固定时刻标记为不支持');
  await assert.rejects(() => client.saveSchedule({ hour: 8, minute: 0 }), /不是每天固定时刻/, '拒绝换算复杂 cron');
  assert.equal(current, complexText, '拒绝时文件原样不变');

  // 完全没有 cron 行时报错，绝不写坏文件。
  use("on:\n  workflow_dispatch:\n");
  await assert.rejects(() => client.loadSchedule(true), /未能识别执行时间配置/);
  await assert.rejects(() => client.saveSchedule({ hour: 8, minute: 0 }), /未能(识别|定位)执行时间配置/);

  console.log('执行时间页面设置回归测试通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
