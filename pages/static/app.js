'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data = null, view = 'overview', loginSession = null, loginTimer = null, bindTab = 'qr', bindAccount = null, pollTimer = null;
let checkRunResult = null;
let refreshPromise=null,refreshVersion=null,pollVersion=0,polling=false,bindVersion=0,bindBusy=null;
const labels = {overview:'总览',accounts:'账户管理',history:'运行记录',settings:'计划与通知'};
const statusLabels = {success:'已完成',failed:'失败',running:'运行中',queued:'排队中',cancelled:'已停止',interrupted:'已中断'};
let toastTimer;
function toast(message, error = false) {const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 4500);}
async function api(path, method = 'GET', body = {}) {
  const client=window.githubClient;
  try {
    if(path==='/session')return {authenticated:client.connected,requires_auth:true};
    if(path==='/auth'){const result=await client.connect(body.repository,body.token,message=>$('#auth-error').textContent=message,body.remember);$('#auth-error').textContent='';return result;}
    if(path==='/logout'){client.disconnect();return {ok:true};}
    if(path==='/overview')return await client.overview();
    if(path==='/run-all')return await client.run();
    if(path==='/accounts/import')return await client.command('import',body);
    let match=path.match(/^\/accounts\/([a-f0-9]{32})(?:\/(run|stop))?$/);
    if(match){const id=match[1];if(match[2]==='run')return await client.run(id);if(match[2]==='stop'){await client.stop(id);return {ok:true};}return await client.command(method==='DELETE'?'delete':'update',{...body,account_id:id});}
    if(path==='/login')return {session_id:await client.start('qr',body)};
    match=path.match(/^\/login\/([a-f0-9]{32})$/);
    if(match)return method==='DELETE'?await client.cancel(match[1]):await client.state(match[1]);
    if(path==='/settings/schedule'){
      // 时间填了才写回 deploy.yml；开关始终写加密状态。
      const time=(body.hour==='' || body.minute==='' || body.hour==null)?null:await client.saveSchedule({hour:Number(body.hour),minute:Number(body.minute)});
      await client.command('schedule',{enabled:body.enabled});
      return {time};
    }
    if(path==='/settings/watchdog')return await client.saveWatchdog({enabled:body.enabled,hour:Number(body.hour),minute:Number(body.minute)});
    if(path==='/settings/email')return await client.command('email',body);
    if(path==='/settings/email/test')return await client.command('test-email',body);
    if(path==='/settings/notifications')return await client.command('notifications',body);
    if(path==='/settings/notifications/test')return await client.command('test-notification',body);
    throw new Error('此操作在 Pages 模式下不可用');
  }catch(error){if(!client.connected && path!=='/auth' && error.code!=='SESSION_CHANGED'){pausePolling();data=null;loginSession=null;clearTimeout(loginTimer);$('#bind-dialog').close();$('#content').innerHTML='<div class="loading">请连接仓库</div>';openAuth(error.message);}throw error;}
}
const tz = () => 'Asia/Shanghai';
const day = date => new Date(date).toLocaleDateString('sv-SE',{timeZone:tz()});
function dateTime(date) {return date ? new Date(date).toLocaleString('zh-CN',{timeZone:tz(),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '尚未安排';}
function badge(status, text) {return `<span class="badge ${esc(status)}">${esc(text || statusLabels[status] || status)}</span>`;}
function checkRunMessage(info) {
  if(info.kind==='ok') return '定时任务本周期已成功运行，无需补跑';
  if(info.kind==='running') return '本次定时任务仍在排队或运行中，暂未补跑';
  if(info.kind==='waiting') return '刚过定时时间，GitHub 可能还在排队，请稍后再检测';
  if(info.kind==='delayed') return '本周期还没有运行记录，GitHub 定时触发可能有延迟，暂未补跑';
  if(info.kind==='skipped') return '本周期已有一次运行成功（手动或补跑），时长已刷上，不再补跑';
  if(info.kind==='disabled') return '自动阅读计划已暂停，未执行检测';
  return '本周期未找到成功运行，已自动补跑一次';
}
let watchdog=null, watchdogVersion=0;
let readingTime=null, readingVersion=0;
// 阅读执行时间面板状态：读取中、损坏、复杂写法分别给出禁用与提示。
function readingTimeState() {
  if(!readingTime) return {blocked:true,hour:'',minute:'',hint:'正在读取仓库中的执行时间…'};
  if(readingTime.error) return {blocked:true,hour:'',minute:'',hint:readingTime.error};
  if(readingTime.supported===false) return {blocked:true,hour:'',minute:'',hint:`当前执行时间「${readingTime.utcCron}」不是每天固定时刻的写法，请先到 GitHub 调整后再用页面设置。`};
  return {blocked:false,hour:readingTime.hour,minute:readingTime.minute,
    hint:readingTime.active===false?`当前定时处于注释状态（UTC ${readingTime.utcCron}），保存时间会同时启用它。`:'填写每天执行的北京时间；两格留空则只保存开关、不改时间。'};
}
async function loadReadingTime(force=false) {
  const version=++readingVersion;
  try{readingTime=await window.githubClient.loadSchedule(force);}
  catch(error){readingTime={error:(error.code==='CONFIGURATION'?error.message:'未能读取执行时间。请确认默认分支包含 .github/workflows/deploy.yml。')};}
  if(version!==readingVersion || view!=='settings') return;
  render();
}
function watchdogBody() {
  if(!watchdog) return '<div class="settings-status">正在读取自动检测设置…</div>';
  if(watchdog.error) return `<div class="settings-status">${esc(watchdog.error)}</div>
    <label class="toggle-label"><span>开启每日自动检测</span><input name="enabled" type="checkbox" class="switch"></label>
    <div class="form-row"><label>每天检查（小时，北京时间）<input name="hour" type="number" min="0" max="23" step="1" value="12"></label><label>分钟<input name="minute" type="number" min="0" max="59" step="1" value="7"></label></div>
    <div class="settings-status">修复配置后可在此保存检查时间。</div><button class="button primary">保存</button>`;
  const hh=String(watchdog.hour).padStart(2,'0'), mm=String(watchdog.minute).padStart(2,'0');
  return `<label class="toggle-label"><span>开启每日自动检测</span><input name="enabled" type="checkbox" class="switch" ${watchdog.enabled?'checked':''}></label>
    <div class="form-row"><label>每天检查（小时，北京时间）<input name="hour" type="number" min="0" max="23" step="1" value="${hh}"></label><label>分钟<input name="minute" type="number" min="0" max="59" step="1" value="${mm}"></label></div>
    <div class="settings-status">每天北京时间 ${hh}:${mm} 自动检查定时阅读是否成功；未运行或失败会自动补跑一次并发通知。</div>
    <button class="button primary">保存</button>`;
}
async function loadWatchdog(force=false) {
  const version=++watchdogVersion;
  try{watchdog=await window.githubClient.loadWatchdog(force);}
  catch(error){watchdog={error:(error.code==='CONFIGURATION'?error.message:'未能读取检测设置。请确认仓库默认分支已包含 .github/workflows/watchdog.yml。')};}
  if(version!==watchdogVersion) return;
  const form=$('#watchdog-form');if(form)form.innerHTML=watchdogBody();
}
function checkRunSummary() {
  if(!checkRunResult) return '';
  const info=checkRunResult;
  if(info.kind==='disabled') return `<div class="summary-row"><span>最近检测</span>${badge('cancelled','计划已暂停')}${icon('clock')}</div><div class="settings-status">自动阅读计划当前为暂停状态，检测会跳过补跑。</div>`;
  if(info.kind==='ok') return `<div class="summary-row"><span>最近检测</span>${badge('success','运行正常')}${icon('check')}</div><div class="settings-status">定时任务在 ${dateTime(info.run.created_at)} 已成功结束，无需补跑。</div>`;
  if(info.kind==='running') return `<div class="summary-row"><span>最近检测</span>${badge('running','正在运行')}${icon('clock')}</div><div class="settings-status">本次定时任务仍在 GitHub 排队或运行中，${esc(runLabel(info.run))}，暂未补跑。</div>`;
  if(info.kind==='waiting') return `<div class="summary-row"><span>最近检测</span>${badge('cancelled','等待触发')}${icon('clock')}</div><div class="settings-status">刚过定时时间，GitHub 还在排队，请几分钟后再检测。</div>`;
  if(info.kind==='delayed') return `<div class="summary-row"><span>最近检测</span>${badge('cancelled','等待调度')}${icon('clock')}</div><div class="settings-status">本周期还没有任何运行记录。GitHub 的定时触发偶尔会延迟数小时（你的任务实际开始时间可能晚于设置时间），为避免和迟到的定时任务重复执行，检测会先等待，超时才补跑。</div>`;
  if(info.kind==='skipped') return `<div class="summary-row"><span>最近检测</span>${badge('success','已有成功记录')}${icon('check')}</div><div class="settings-status">本周期在北京时间 ${dateTime(info.run.created_at)} 有一次运行成功（手动触发或上一轮补跑），时长已刷上，不再补跑。</div>`;
  if(info.kind==='rerun') return `<div class="summary-row"><span>最近检测</span>${badge('warning','已自动补跑')}${icon('play')}</div><div class="settings-status">本周期未找到成功的运行记录${info.attempts?`（共 ${info.attempts} 次尝试${info.fallback?'，暂按最近 24 小时判断':''}）`:'，且尚未有运行记录'}，已自动重新发起一次任务${info.result?.started?.length?`，覆盖 ${info.result.started.length} 个账户`:''}。</div>`;
  return '';
}
function runLabel(run) {return run.status==='waiting'?'正在等待环境审批':'正在排队或执行';}
function header(title, actions = true) {return `<div class="page-header"><h1>${title}</h1>${actions ? `<div class="header-actions"><button class="button" data-action="check-run">${icon('shield')}检测运行</button><button class="button" data-action="run-all" ${data.accounts.some(a=>a.enabled && a.status==='ready') ? '' : 'disabled'}>${icon('play')}运行全部</button><button class="button primary" data-action="bind">${icon('plus')}添加账户</button></div>` : ''}</div>`;}
function accountTable() {
  if (!data.accounts.length) return `<div class="empty"><div class="empty-icon">${icon('book')}</div><h3>暂无账户</h3><button class="button primary" data-action="bind">${icon('plus')}添加账户</button></div>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>账户</th><th>登录状态</th><th>目标时长</th><th>最近运行</th><th>操作</th></tr></thead><tbody>${data.accounts.map(a=>{
    const run=data.runs.find(r=>r.account_id===a.id), active=run && ['running','queued'].includes(run.status);
    return `<tr><td><div class="account-name"><span class="avatar">${esc(a.name.slice(0,1))}</span><div><strong>${esc(a.name)}</strong><small>${a.enabled?'自动阅读已开启':'自动阅读已暂停'}</small></div></div></td><td>${badge(a.status==='needs_login'?'warning':'success',a.status==='needs_login'?'需要重新绑定':'已绑定')}</td><td>${a.read_num/2} <span class="muted">分钟</span></td><td>${run ? `${badge(run.status)}${active ? `<progress value="${run.completed}" max="${run.target}" aria-label="阅读进度"></progress>` : `<div class="notification-status">${dateTime(run.started_at)}</div>`}` : '<span class="muted">尚未运行</span>'}</td><td><div class="row-actions"><button class="button small" data-action="${active?'stop':'run'}" data-id="${a.id}" ${!active && a.status==='needs_login'?'disabled':''}>${icon(active?'stop':'play')}${active?'停止本批':'运行'}</button><button class="icon-button" data-action="rebind" data-id="${a.id}" ${active?'disabled':''} title="重新扫码" aria-label="重新扫码绑定 ${esc(a.name)}">${icon('qr')}</button><button class="icon-button" data-action="edit" data-id="${a.id}" ${active?'disabled':''} title="账户设置" aria-label="设置 ${esc(a.name)}">${icon('edit')}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function chart() {
  const days = data.statistics.days.map(d=>({...d,label:Number(d.date.slice(5,7))+'/'+Number(d.date.slice(8,10))}));
  const max=Math.max(30,...days.map(d=>d.minutes));
  return `<div class="chart"><svg viewBox="0 0 490 165" role="img" aria-label="最近七天的任务记录时长，单位分钟">${[0,1,2].map(i=>`<path class="gridline" d="M35 ${20+i*52}H483"/><text class="axis-text" x="0" y="${23+i*52}">${Math.round(max*(1-i/2))}</text>`).join('')}${days.map((d,i)=>{const x=56+i*62,h=d.minutes/max*104;return `<rect class="bar-base" x="${x}" y="20" width="22" height="104" rx="4"/><rect class="bar ${i===6?'today':''}" x="${x}" y="${124-h}" width="22" height="${h}" rx="4"><title>${d.label}：${d.minutes} 分钟</title></rect><text class="axis-text" text-anchor="middle" x="${x+11}" y="149">${i===6?'今天':d.label}</text>`;}).join('')}</svg><div class="chart-caption"><span class="legend">任务记录时长</span><span>${days.some(d=>d.minutes>0)?'单位：分钟':'暂无记录'}</span></div></div>`;
}
function renderOverview() {
  const stats=data.statistics.today;
  const metrics=[['账户数',data.accounts.length,'个','','users'],['今日记录时长',stats.minutes,'分钟','','clock'],['今日完成任务',stats.success,'次',`${stats.running} 个任务运行中`,'check'],['通知通道',activeNotificationNames(data).length||'未设置',activeNotificationNames(data).length?'个':'',activeNotificationNames(data).join(' · '),'mail']];
  $('#content').innerHTML = header('总览') + `<div class="metrics">${metrics.map(([label,value,unit,note,i])=>`<div class="metric"><div class="metric-top">${label}<span class="metric-icon">${icon(i)}</span></div><div class="metric-value ${i==='mail'?'mini':''}">${value}<small>${unit}</small></div>${note?`<div class="metric-note">${note}</div>`:''}</div>`).join('')}</div><section class="panel"><div class="panel-head"><div><h2>我的账户<span>${data.accounts.length} 个账户</span></h2></div><button class="text-button" data-action="view" data-view="accounts">管理账户${icon('arrow')}</button></div>${accountTable()}</section><div class="overview-lower"><section class="panel"><div class="panel-head"><h2>阅读统计</h2><span class="subtle-tag">最近 7 天</span></div>${chart()}</section><section class="panel"><div class="panel-head"><h2>定时阅读</h2><button class="text-button" data-action="view" data-view="settings">调整${icon('arrow')}</button></div><div class="schedule-summary"><div class="summary-row"><span>自动阅读</span>${badge(data.schedule.enabled?'success':'cancelled',data.schedule.enabled?'已开启':'已暂停')}</div><div class="summary-row"><span>参与账户</span><strong>${data.accounts.filter(a=>a.enabled && a.status==='ready').length} 个账户</strong></div><div class="summary-row"><span>时区</span><strong>${esc(tz())}</strong></div><div class="summary-next">${icon('clock')}<div>下次执行时间<strong>${data.schedule.enabled?dateTime(data.next_run):'自动计划已暂停'}</strong></div></div>${checkRunSummary()}</div></section></div>`;
}
function renderAccounts() {$('#content').innerHTML=header('账户管理')+`<section class="panel"><div class="panel-head"><h2>全部账户<span>${data.accounts.length} 个</span></h2></div>${accountTable()}</section>`;}
function historyTable(runs) {
  if(!runs.length) return `<div class="empty"><div class="empty-icon">${icon('list')}</div><h3>暂无运行记录</h3></div>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>账户</th><th>开始时间</th><th>状态</th><th>完成 / 目标</th><th>结果</th></tr></thead><tbody>${runs.map(r=>`<tr><td>${esc(r.account_name)}</td><td>${dateTime(r.started_at)}</td><td>${badge(r.status)}</td><td>${r.completed/2} / ${r.target/2} 分钟</td><td class="history-message">${esc(r.message)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderHistory() {const focused=document.activeElement?.id==='history-search', position=$('#history-search')?.selectionStart; const query=$('#history-search')?.value || '';$('#content').innerHTML=header('运行记录',false)+`<section class="panel"><div class="panel-head"><h2>运行记录<span>${data.runs.length} 条</span></h2><input id="history-search" class="search-input" placeholder="搜索账户或结果" aria-label="搜索运行记录" value="${esc(query)}"></div><div id="history-list">${historyTable(data.runs.filter(r=>`${r.account_name} ${r.message}`.includes(query)))}</div></section>`;if(focused){$('#history-search').focus();$('#history-search').setSelectionRange(position,position);}}
function renderSettings() {
  const s=data.schedule,e=data.email,r=readingTimeState();
  const scheduleUrl=window.githubClient.url('/edit/'+encodeURIComponent(window.githubClient.branch||'main')+'/.github/workflows/deploy.yml');
  $('#content').innerHTML=header('计划与通知',false)+`
    <div class="settings-layout">
      <section class="panel">
        <div class="panel-head"><h2>定时阅读</h2>${icon('clock')}</div>
        <form id="schedule-form" class="settings-body">
          <label class="toggle-label"><span>开启定时阅读</span><input name="enabled" type="checkbox" class="switch" ${s.enabled?'checked':''}></label>
          <div class="form-row"><label>每天执行（小时，北京时间）<input name="hour" type="number" min="0" max="23" step="1" value="${esc(r.hour)}"${r.blocked?' disabled':''}></label><label>分钟<input name="minute" type="number" min="0" max="59" step="1" value="${esc(r.minute)}"${r.blocked?' disabled':''}></label></div>
          <p class="settings-status">${esc(r.hint)}</p>
          <a class="text-button schedule-link" href="${esc(scheduleUrl)}" target="_blank" rel="noopener noreferrer">在 GitHub 查看完整配置 ↗</a>
          <button class="button primary">保存</button>
          <div class="settings-status">下次：${s.enabled?dateTime(data.next_run):'已暂停'}</div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>自动检测</h2>${icon('shield')}</div>
        <form id="watchdog-form" class="settings-body">${watchdogBody()}</form>
      </section>
      <div class="notification-settings">
        <details class="panel notification-panel" ${e.enabled?'open':''}>
          <summary class="panel-head"><h2>邮件通知<span>${e.enabled?'已开启':'未开启'}</span></h2>${icon('arrow')}</summary>
          <form id="email-form" class="settings-body">
            <label class="toggle-label"><span>开启邮件通知</span><input name="enabled" type="checkbox" class="switch" ${e.enabled?'checked':''}></label>
            <div class="form-row"><label>SMTP 服务器<input name="host" placeholder="smtp.qq.com" value="${esc(e.host)}"></label><label>端口<input name="port" type="number" min="1" max="65535" value="${esc(e.port)}"></label></div>
            <label>连接加密<select name="security"><option value="ssl" ${e.security==='ssl'?'selected':''}>SSL / TLS</option><option value="starttls" ${e.security==='starttls'?'selected':''}>STARTTLS</option></select></label>
            <label>邮箱账号<input name="username" value="${esc(e.username)}" placeholder="邮箱地址" autocomplete="off"></label>
            <label>授权码<input name="password" type="password" placeholder="${e.has_password?'已保存，留空保留':'SMTP 授权码'}" autocomplete="new-password"></label>
            <label>发件邮箱<input name="sender" type="email" value="${esc(e.sender)}" placeholder="sender@example.com"></label>
            <label>默认收件邮箱<input name="recipient" value="${esc(e.recipient)}" placeholder="多个邮箱用英文逗号分隔"></label>
            <div class="actions-group"><button class="button primary">保存</button><button type="button" id="test-email" class="button">${icon('mail')}发送测试邮件</button></div>
            <p id="email-result" class="form-error" role="status"></p>
          </form>
        </details>
        ${notificationCards(data.notifications)}
      </div>
    </div>`;
  if(!watchdog) loadWatchdog();
  if(!readingTime) loadReadingTime();
}
function render() {if(!data) return;$('#nav-count').textContent=data.accounts.length;$('#breadcrumb').textContent=labels[view];$$('[data-view].nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));({overview:renderOverview,accounts:renderAccounts,history:renderHistory,settings:renderSettings})[view]();}
function setView(next) {view=next;render();window.scrollTo({top:0});}
async function refresh(force=false) {
  const client=window.githubClient,version=client.sessionVersion;
  if(refreshVersion!==version)refreshPromise=null;
  if(!refreshPromise){
    refreshVersion=version;
    const task=(async()=>{
      try {
        const result=await api('/overview');if(version!==client.sessionVersion || !client.connected)return false;
        if(!data || Number(result.revision||0)>=Number(data.revision||0))data=result;
        $('#connection').textContent='GitHub 已连接';$('#connection').title='';return true;
      }catch(e){
        if(e.code==='SESSION_CHANGED' || version!==client.sessionVersion)return false;
        $('#connection').textContent=!client.connected?'需要重新连接':e.code==='RATE_LIMIT'?'限流中 · 等待恢复':e.code==='PERMISSION'?'需要检查仓库权限':'网络波动 · 自动重试';
        $('#connection').title=e.message;if(force)toast(e.message,true);return false;
      }
    })();
    refreshPromise=task;task.finally(()=>{if(refreshPromise===task)refreshPromise=null;});
  }
  const ok=await refreshPromise;if(ok && (force || view!=='settings'))render();return ok;
}
function pausePolling() {polling=false;pollVersion++;clearTimeout(pollTimer);pollTimer=null;}
function startPolling(immediate=false) {
  pausePolling();if(!window.githubClient.connected)return;polling=true;const version=pollVersion;
  const schedule=delay=>{if(version===pollVersion && polling && document.visibilityState!=='hidden')pollTimer=setTimeout(tick,delay);};
  const tick=async()=>{if(version!==pollVersion || !polling)return;const ok=await refresh();if(window.githubClient.connected)schedule(Math.max(ok?(data?.runs?.some(run=>['running','queued'].includes(run.status))?15000:60000):30000,window.githubClient.retryAt-Date.now() || 0));};
  schedule(immediate?0:10000);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearTimeout(pollTimer);pollTimer=null;}else if(polling)startPolling(true);});
window.addEventListener('online',()=>{if(window.githubClient.connected)startPolling(true);});
async function closeQR() {clearTimeout(loginTimer);loginTimer=null;if(loginSession){const id=loginSession;loginSession=null;try{await api('/login/'+id,'DELETE');}catch{}}}
function openBind(account=null) {bindVersion++;closeQR();$('#import-submit').disabled=false;bindAccount=account;bindTab='qr';$('#bind-form').reset();$('#bind-title').textContent=account?'重新绑定账户':'添加账户';$('#bind-form').elements.name.value=account?.name || '';$('#bind-form').elements.minutes.value=account?account.read_num/2:20;$('#bind-form').elements.email.value=account?.email || '';$('#bind-error').textContent='';$('#qr-area').innerHTML=`${icon('qr')}<span>点击生成二维码</span>`;$('#qr-status').textContent='';$('#qr-start').disabled=false;$('#qr-start').textContent='生成二维码';$('#qr-refresh').hidden=true;$('#bind-form').elements.name.disabled=!!account;$('#bind-form').elements.minutes.disabled=!!account;$('#bind-form').elements.email.disabled=!!account;$$('[data-bind-tab]').forEach(b=>{b.hidden=!!account&&b.dataset.bindTab==='import';b.classList.toggle('active',b.dataset.bindTab==='qr');});$('#qr-panel').hidden=false;$('#import-panel').hidden=true;$('#bind-dialog').showModal();}
function renderQRState(state) {
  $('#qr-status').textContent=state.message;
  if(state.qr){
    let image=$('#qr-area img');if(!image){$('#qr-area').innerHTML='<img alt="微信读书官方登录二维码">';image=$('#qr-area img');}
    if(image.getAttribute('src')!==state.qr)image.src=state.qr;
  }else{
    $('#qr-area').innerHTML=`${icon('qr')}<span>${state.status==='retrying'?'网络恢复后继续读取二维码…':state.status==='refreshing'?'正在更新二维码…':state.status==='starting'?'等待扫码任务准备完成…':'本次二维码已结束'}</span>`;
  }
}
function bindingSaved(result) {
  const binding=result.binding;
  if(!binding || !result.overview?.accounts.some(account=>account.id===binding.account_id))throw new Error('未确认账户保存结果，请重试或刷新账户列表');
  window.githubClient.acceptOverview(result.overview);data=window.githubClient.data;
  render();
  return binding;
}
async function pollQR(id) {
  if(loginSession!==id || !$('#bind-dialog').open)return;
  try {
    const state=await api('/login/'+id);if(loginSession!==id)return;
    renderQRState(state);
    $('#qr-refresh').hidden=false;$('#qr-refresh').disabled=state.status!=='waiting';
    if(state.status==='success'){
      const binding=bindingSaved(state);loginSession=null;$('#qr-refresh').hidden=true;$('#qr-start').disabled=false;
      if(binding.action==='updated' && !bindAccount){
        $('#qr-status').textContent='已更新已有账户：'+binding.name+'，未新增账户';
        $('#qr-area').innerHTML=`${icon('check')}<span>登录信息已更新</span>`;
        $('#qr-start').textContent='绑定其他账户';
      }else{$('#bind-dialog').close();toast(binding.action==='added'?'已添加账户：'+binding.name:'账户登录信息已更新');}
      await refresh(true);return;
    }
    if(['failed','expired','cancelled'].includes(state.status)){
      loginSession=null;$('#qr-refresh').hidden=true;$('#bind-error').textContent=state.message;
      $('#qr-start').disabled=false;$('#qr-start').textContent='重新生成二维码';
      window.githubClient.cancel(id).catch(()=>{});return;
    }
    loginTimer=setTimeout(()=>pollQR(id),state.status==='starting'?3000:2500);
  }catch(e){
    if(loginSession!==id)return;
    if(e.retryable && window.githubClient.connected){renderQRState({status:'retrying',message:e.message});loginTimer=setTimeout(()=>pollQR(id),Math.max(5000,window.githubClient.retryAt-Date.now() || 0));return;}
    renderQRState({status:'failed',message:e.message});loginSession=null;$('#qr-refresh').hidden=true;
    $('#bind-error').textContent=e.message;$('#qr-start').disabled=false;$('#qr-start').textContent='重新生成二维码';
    window.githubClient.cancel(id).catch(()=>{});
  }
}
$('#qr-refresh').addEventListener('click',async()=>{
  const id=loginSession;if(!id)return;
  $('#qr-refresh').disabled=true;$('#bind-error').textContent='';renderQRState({status:'refreshing',message:'正在刷新二维码…'});
  try{await window.githubClient.refreshQR(id);}catch(error){if(loginSession===id){$('#bind-error').textContent=error.message;$('#qr-refresh').disabled=false;}}
});
function editAccount(account) {const f=$('#edit-form');f.elements.id.value=account.id;f.elements.name.value=account.name;f.elements.minutes.value=account.read_num/2;f.elements.email.value=account.email;f.elements.enabled.checked=account.enabled;$('#edit-error').textContent='';$('#edit-dialog').showModal();}
function emailValues(){const f=$('#email-form'), values=Object.fromEntries(new FormData(f));values.enabled=f.elements.enabled.checked;return values;}
function openAuth(message='') {$('#logout').hidden=true;$('#connection').textContent=message?'需要重新连接':'尚未连接';if(message)$('#auth-error').textContent=message;if(!$('#auth-dialog').open)$('#auth-dialog').showModal();}
$('#auth-dialog').addEventListener('cancel',e=>e.preventDefault());
document.addEventListener('click',async e=>{
  if(e.target.closest('.brand')){e.preventDefault();setView('overview');return;}
  const close=e.target.closest('[data-close]');if(close){$('#'+close.dataset.close).close();return;}
  const nav=e.target.closest('.nav-item');if(nav){setView(nav.dataset.view);return;}
  const tab=e.target.closest('[data-bind-tab]');if(tab){if(bindTab===tab.dataset.bindTab)return;bindVersion++;closeQR();bindTab=tab.dataset.bindTab;$$('[data-bind-tab]').forEach(b=>b.classList.toggle('active',b===tab));$('#qr-panel').hidden=bindTab!=='qr';$('#import-panel').hidden=bindTab!=='import';$('#import-submit').disabled=false;$('#qr-start').disabled=false;$('#qr-refresh').hidden=true;$('#bind-error').textContent='';return;}
  const button=e.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action, id=button.dataset.id, account=data?.accounts.find(a=>a.id===id);
  if(action==='bind'){openBind();return;}if(action==='rebind'){openBind(account);return;}if(action==='edit'){editAccount(account);return;}if(action==='view'){setView(button.dataset.view);return;}
  button.disabled=true;
  try {if(action==='check-run'){button.innerHTML=`${icon('clock')}正在检测…`;const info=await window.githubClient.checkScheduledRun();checkRunResult=info;toast(checkRunMessage(info));}else if(action==='run-all'){const result=await api('/run-all','POST',{});toast(result.started.length?`已启动 ${result.started.length} 个账户任务${result.skipped.length?'；部分账户已在运行或需要重新绑定':''}`:'暂无可以启动的账户任务');}else if(action==='run'){await api('/accounts/'+id+'/run','POST',{});toast('阅读任务已启动');}else if(action==='stop'){await api('/accounts/'+id+'/stop','POST',{});toast('已请求取消本批 Actions 阅读任务');}await refresh(true);}catch(err){toast(err.message,true);button.disabled=false;if(action==='check-run')button.innerHTML=`${icon('shield')}检测运行`;}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target, formId=e.target.getAttribute('id'), submit=e.submitter || $('button[type=submit],button:not([type])',f);if(submit)submit.disabled=true;
  const version=bindVersion;let ownsBinding=false;
  try {
    if(formId==='auth-form'){pausePolling();const result=await api('/auth','POST',{token:f.elements.token.value,repository:f.elements.repository.value.trim(),remember:f.elements.remember.checked});f.elements.token.value='';$('#auth-dialog').close();$('#logout').hidden=false;if(result?.saved===false)toast('浏览器无法保存登录信息，刷新后需要重新连接',true);await refresh(true);startPolling();}
    if(formId==='bind-form'){if(bindBusy===version)return;bindBusy=version;ownsBinding=true;const options={name:f.elements.name.value,read_num:Number(f.elements.minutes.value)*2,email:f.elements.email.value};if(bindAccount)options.account_id=bindAccount.id;
      if(bindTab==='import'){
        const result=await api('/accounts/import','POST',{...options,curl:f.elements.curl.value});const binding=bindingSaved(result);
        if(version!==bindVersion || !$('#bind-dialog').open){await refresh(true);return;}
        if(binding.action==='updated' && !bindAccount){$('#bind-error').textContent='已更新已有账户：'+binding.name+'，未新增账户';}
        else{f.reset();$('#bind-dialog').close();toast('已添加账户：'+binding.name);}await refresh(true);
      }else{
        await closeQR();if(version!==bindVersion || !$('#bind-dialog').open)return;
        $('#bind-error').textContent='';renderQRState({status:'starting',message:'生成中…'});$('#qr-start').disabled=true;
        const result=await api('/login','POST',options);
        if(version!==bindVersion || !$('#bind-dialog').open){window.githubClient.cancel(result.session_id).catch(()=>{});return;}
        loginSession=result.session_id;$('#qr-refresh').hidden=false;$('#qr-refresh').disabled=true;pollQR(loginSession);
      }
    }
    if(formId==='edit-form'){await api('/accounts/'+f.elements.id.value,'PATCH',{name:f.elements.name.value,read_num:Number(f.elements.minutes.value)*2,email:f.elements.email.value,enabled:f.elements.enabled.checked});$('#edit-dialog').close();toast('账户设置已保存');await refresh(true);}
    if(formId==='schedule-form'){
      const hour=f.elements.hour.value.trim(), minute=f.elements.minute.value.trim();
      if((hour==='')!==(minute===''))throw new Error('执行时间请同时填写小时和分钟，或两格都留空表示只保存开关');
      if(hour!=='' && (!/^\d+$/.test(hour) || !/^\d+$/.test(minute) || Number(hour)>23 || Number(minute)>59))throw new Error('执行时间需为 0-23 的小时和 0-59 的分钟');
      const result=await api('/settings/schedule','PUT',{enabled:f.elements.enabled.checked,hour,minute});
      await loadReadingTime(true);await refresh(true);
      toast(result.time&&result.time.changed?`执行时间已设为每天北京时间 ${String(result.time.hour).padStart(2,'0')}:${String(result.time.minute).padStart(2,'0')}${result.time.activated?'，并已启用被注释的定时配置':''}`:'阅读计划已保存');
    }
    if(formId==='watchdog-form'){const hour=Number(f.elements.hour.value), minute=Number(f.elements.minute.value);if(!(hour>=0&&hour<=23) || !(minute>=0&&minute<=59) || hour%1 || minute%1)throw new Error('检查时间需为 0-23 的时和 0-59 的分');const saved=await api('/settings/watchdog','PUT',{enabled:f.elements.enabled.checked,hour,minute});watchdog={...watchdog,...saved};f.innerHTML=watchdogBody();await refresh(true);toast(saved.changed?(saved.enabled?`已设置为每天北京时间 ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} 自动检测`:'自动检测已关闭，定时文件已停用'):'设置已是最新，无需保存');}
    if(formId==='email-form'){await api('/settings/email','PUT',emailValues());await refresh(true);toast('邮件设置已保存');}
    if(f.dataset.notificationChannel){await api('/settings/notifications','PUT',notificationValues(f));await refresh(true);toast(notificationLabels[f.dataset.notificationChannel]+' 通知设置已保存');}
  }catch(err){if(formId==='bind-form' && version!==bindVersion)return;const target={ 'bind-form':'#bind-error','edit-form':'#edit-error','auth-form':'#auth-error','email-form':'#email-result'}[formId]||(f.dataset.notificationChannel?'#notification-result-'+f.dataset.notificationChannel:null);if(target)$(target).textContent=err.message;else toast(err.message,true);}
  finally {if(ownsBinding && bindBusy===version)bindBusy=null;if(submit && (formId!=='bind-form' || (version===bindVersion && bindBusy!==version && !(bindTab==='qr' && loginSession))))submit.disabled=false;}
});
document.addEventListener('input',e=>{if(e.target.id==='history-search'){$('#history-list').innerHTML=historyTable(data.runs.filter(r=>`${r.account_name} ${r.message}`.includes(e.target.value)));}});
document.addEventListener('click',async e=>{if(e.target.closest('#test-email')){const b=$('#test-email');b.disabled=true;$('#email-result').textContent='正在发送测试邮件…';try{await api('/settings/email/test','POST',emailValues());$('#email-result').textContent='测试邮件已发送';toast('测试邮件已发送');}catch(err){$('#email-result').textContent=err.message;}finally{b.disabled=false;}}});
$('#delete-account').addEventListener('click',()=>$('#confirm-dialog').showModal());
$('#confirm-delete').addEventListener('click',async()=>{const b=$('#confirm-delete');b.disabled=true;try{await api('/accounts/'+$('#edit-form').elements.id.value,'DELETE');$('#confirm-dialog').close();$('#edit-dialog').close();toast('账户已移除');await refresh(true);}catch(e){toast(e.message,true);}finally{b.disabled=false;}});
$('#logout').addEventListener('click',async()=>{await api('/logout','POST',{});pausePolling();data=null;watchdog=null;readingTime=null;$('#content').innerHTML='<div class="loading">请连接仓库</div>';openAuth();});
$('#bind-dialog').addEventListener('close',()=>{if(!$('#bind-dialog').open){bindVersion++;closeQR();}});
$('#today-label').textContent=new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'});
(async()=>{try{await sodium.ready;$('#connection').textContent='正在恢复连接';await window.githubClient.restore();if(!window.githubClient.connected){$('#connection').textContent='尚未连接';openAuth();return;}$('#logout').hidden=false;await refresh(true);startPolling();}catch(e){if(window.githubClient.connected){$('#logout').hidden=false;await refresh(true);startPolling();}else{$('#connection').textContent='需要重新连接';openAuth(e.message);}}})();

const guessedRepo=location.hostname.endsWith('.github.io')?location.hostname.split('.')[0]+'/'+(location.pathname.split('/').filter(Boolean)[0]||location.hostname):'wbshm/wxread';
try{$('#auth-form').elements.repository.value=localStorage.getItem('wxread-repository')||guessedRepo;}catch{$('#auth-form').elements.repository.value=guessedRepo;}
