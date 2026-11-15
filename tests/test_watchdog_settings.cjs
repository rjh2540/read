// 页面设置自动检测时间的读写与保存逻辑测试。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const scope = vm.createContext({ window: {}, Date, console });
scope.sodium = { to_string: bytes => Buffer.from(bytes).toString('utf8'), from_string: text => Buffer.from(text, 'utf8') };
vm.runInContext(fs.readFileSync(path.join(__dirname, '../pages/static/github.js'), 'utf8'), scope);
const client = scope.window.githubClient;

const FILE = path.join(__dirname, '../.github/workflows/watchdog.yml');
const ORIGINAL = fs.readFileSync(FILE, 'utf8');
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

let current = ORIGINAL, writes = [];
client.branch = 'main';
client.b64 = value => Buffer.from(value).toString('base64');
client.bytes = value => Buffer.from(value, 'base64');
client.request = async (urlPath, method = 'GET', body) => {
  if (method === 'GET') return { content: b64(current), sha: 'sha-original' };
  writes.push(body); current = Buffer.from(body.content, 'base64').toString('utf8'); return null;
};

async function main() {
  assert.equal(client.toUtcCron(12, 7), '7 4 * * *', '北京时间 12:07 换算为 UTC 04:07');
  assert.equal(client.toUtcCron(3, 30), '30 19 * * *', '凌晨时间换算后绕回前一天 19 点');
  assert.equal(client.toUtcCron(0, 0), '0 16 * * *', '北京时间 0 点等于 UTC 16 点');

  const loaded = await client.loadWatchdog(true);
  assert.equal(loaded.enabled, true, '未注释的 schedule 视为开启');
  assert.equal(`${loaded.hour}:${loaded.minute}`, '12:7', '仓库里的 UTC 时间按北京时间展示');

  const saved = await client.saveWatchdog({ enabled: true, hour: 20, minute: 15 });
  assert.equal(saved.changed, true, '修改时间需要写入仓库');
  assert.equal(saved.hour, 20); assert.equal(saved.minute, 15);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, 'main');
  assert.equal(writes[0].sha, 'sha-original', '提交时带上文件版本号避免覆盖他人改动');
  assert.ok(current.includes("- cron: '15 12 * * *'"), '保存后写入北京时间 20:15 对应的 UTC');
  assert.ok(current.includes('每天北京时间 20:15'), '文件说明同步为北京时间');

  const off = await client.saveWatchdog({ enabled: false, hour: 20, minute: 15 });
  assert.equal(off.enabled, false);
  assert.ok(!/^\s*schedule:/m.test(current), '关闭后不应留下生效的 schedule');
  assert.ok(!/^[ \t]*- cron:/m.test(current), '关闭后不应留下生效的 cron');
  assert.ok(/^[ \t]*#[ \t]*schedule:/m.test(current) && /^[ \t]*#[ \t]*-[ \t]*cron:/m.test(current),
    '关闭时整块注释，避免空的 schedule 使工作流不合法');
  assert.ok(!current.includes('on:\n  \n'), 'on 段落仍保留 workflow_dispatch');
  assert.ok(current.includes('workflow_dispatch:'), '仍可手动触发检测');

  // 关闭状态下读取，应识别为未开启并按注释里的时间显示。
  client.watchdogCache = null;
  const afterOff = await client.loadWatchdog(true);
  assert.equal(afterOff.enabled, false);
  assert.equal(`${afterOff.hour}:${afterOff.minute}`, '20:15', '关闭时仍显示上次设置的时间');

  // 再开启应恢复成生效配置。
  const back = await client.saveWatchdog({ enabled: true, hour: 8, minute: 5 });
  assert.equal(back.enabled, true);
  assert.ok(current.includes("    - cron: '5 0 * * *'"), '重新开启写回北京时间 08:05');

  // 时间未变时不应重复提交。
  const before = writes.length;
  const same = await client.saveWatchdog({ enabled: true, hour: 8, minute: 5 });
  assert.equal(same.changed, false, '设置未变化时不产生新提交');
  assert.equal(writes.length, before);

  // 配置被人改坏时应拒绝保存，而不是写坏工作流。
  current = ORIGINAL.replace(/  schedule:\n    - cron: '[^']*'/, '  schedule:');
  client.watchdogCache = null;
  await assert.rejects(() => client.loadWatchdog(true), /未能识别检测时间配置/, '损坏配置给出明确提示');
  current = ORIGINAL.replace("- cron: '7 4 * * *'", "- somethingElse: 'x'");
  client.watchdogCache = null;
  await assert.rejects(() => client.saveWatchdog({ enabled: true, hour: 9, minute: 0 }),
    /未能(识别|定位)检测时间配置/, '结构异常时放弃保存以免损坏文件');

  console.log(`自动检测时间设置回归测试通过（写入 ${writes.length} 次）`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
