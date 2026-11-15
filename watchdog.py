"""Watchdog: check whether the scheduled reading run succeeded, otherwise trigger it once.

Runs as its own GitHub Actions schedule, a few hours after the reading workflow. It only
reads workflow run records and, when needed, dispatches the existing reading workflow once.
"""
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

WORKFLOW = 'deploy.yml'
CRON_LINE = re.compile(r"^\s*- cron:\s*['\"]([^'\"]+)['\"]", re.M)
GRACE_SECONDS = 30 * 60
REQUEST_TIMEOUT = (10, 30)


def cron_lines(text=None):
    """Enabled cron lines of the reading workflow; commented-out schedules stay ignored."""
    if text is None:
        path = Path(__file__).parent / '.github' / 'workflows' / WORKFLOW
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            return []
    return CRON_LINE.findall(text or '')


def _field(value, mod):
    numbers = set()
    for part in str(value).split(','):
        if not re.fullmatch(r'\d+', part):
            return None
        number = int(part)
        if number >= mod:
            return None
        numbers.add(number)
    return numbers


def last_fire(cron, now):
    """Most recent UTC fire time of a “minute hour * * *” schedule, or None when unsupported."""
    parts = str(cron or '').split()
    if len(parts) != 5 or parts[2:] != ['*', '*', '*']:
        return None
    minutes, hours = _field(parts[0], 60), _field(parts[1], 24)
    if minutes is None or hours is None:
        return None
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for back in range(8):
        day = midnight - timedelta(days=back)
        fires = [day + timedelta(hours=hour, minutes=minute)
                 for hour in sorted(hours) for minute in sorted(minutes)]
        passed = [fire for fire in fires if fire <= now]
        if passed:
            return max(passed)
    return None


def window(crons, now):
    """Start of the current schedule cycle; falls back to the last 24 hours when unparsable."""
    fires = [fire for fire in (last_fire(cron, now) for cron in crons) if fire]
    if fires:
        return max(fires), False
    return now - timedelta(hours=24), True


def created_at(run):
    value = str(run.get('created_at') or '').replace('Z', '+00:00')
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def decide(runs, since, now=None):
    """Classify the cycle: running / ok / waiting / rerun."""
    now = now or datetime.now(timezone.utc)
    recent = [run for run in runs if created_at(run) >= since]
    active = next((run for run in recent if run.get('status') != 'completed'), None)
    if active:
        return {'action': 'running', 'run': active,
                'message': f"仍有任务在{('等待审批' if active.get('status') == 'waiting' else '排队或运行中')}，本次不补跑"}
    scheduled = [run for run in recent if run.get('event') == 'schedule']
    if any(run.get('conclusion') == 'success' for run in scheduled):
        return {'action': 'ok', 'message': '定时任务本周期已成功运行，无需补跑'}
    # 本周期若已有一次手动运行或上一轮补跑成功，说明时长已刷上，不再重复触发。
    done = next((run for run in recent if run.get('event') != 'schedule' and run.get('conclusion') == 'success'), None)
    if done:
        return {'action': 'skipped', 'run': done,
                'message': '本周期已有一次成功运行（手动触发或此前补跑），时长已刷上，不补跑'}
    if (now - since).total_seconds() < GRACE_SECONDS:
        return {'action': 'waiting', 'message': '刚过定时时间，GitHub 可能还在排队，本次不补跑'}
    return {'action': 'rerun', 'attempts': len(scheduled), 'unmatched': not scheduled,
            'message': (f'本周期定时任务共 {len(scheduled)} 次尝试均未成功' if scheduled
                        else '本周期没有找到定时任务运行记录')}


class GitHub:
    def __init__(self):
        self.repository = os.environ['GITHUB_REPOSITORY']
        self.token = os.getenv('GH_TOKEN') or os.environ['GITHUB_TOKEN']

    def request(self, method, path, value=None):
        url = 'https://api.github.com/repos/' + self.repository + path
        headers = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'wxread-watchdog'}
        try:
            response = requests.request(method, url, headers=headers, json=value,
                                        timeout=REQUEST_TIMEOUT, allow_redirects=False)
        except requests.RequestException:
            raise RuntimeError('无法连接 GitHub API') from None
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f'GitHub API 请求失败（HTTP {response.status_code}）')
        return response.json() if response.content else None

    def runs(self):
        # 一次取回最近记录，完成与未完成状态都交给 decide 判断，同时覆盖定时、手动与补跑来源。
        return self.request('GET', f'/actions/workflows/{WORKFLOW}/runs?per_page=50').get('workflow_runs', [])

    def dispatch(self, ref):
        self.request('POST', f'/actions/workflows/{WORKFLOW}/dispatches',
                     {'ref': ref, 'inputs': {'account_id': ''}})


def report(content, is_success=True):
    """Notify through the channels saved by the Pages console, or the original environment variables."""
    email_config = channels = None
    try:
        from github_state import GitHubState
        state, _ = GitHubState().read()
        email_config, channels = state['email'], state['notifications']
    except Exception as exc:  # Missing key or legacy secrets: fall back to environment settings.
        logging.info('将按环境变量配置发送通知（%s）', type(exc).__name__)
    from notifications import CHANNEL_LABELS, send_notifications
    result = send_notifications(content, email_config=email_config, channels=channels, is_success=is_success)
    if result['succeeded']:
        logging.info('通知已发送：%s', '、'.join(CHANNEL_LABELS[channel] for channel in result['succeeded']))
    elif not result['failed']:
        logging.info('没有开启通知渠道，仅记录 Actions 日志')
    else:
        logging.warning('通知未送达：%s', '、'.join(CHANNEL_LABELS[channel] for channel in result['failed']))


def ready_accounts():
    try:
        from github_state import GitHubState
        state, _ = GitHubState().read()
    except Exception:
        return None  # Legacy deployment without encrypted state: assume usable.
    if not state['schedule'].get('enabled', True):
        return 'paused'
    return [a for a in state['accounts'] if a.get('enabled') and a.get('status') != 'needs_login']


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    now = datetime.now(timezone.utc)
    since, fallback = window(cron_lines(), now)
    logging.info('检测周期起点：%s%s', since.isoformat(), '（未能解析定时配置，按最近 24 小时）' if fallback else '')
    github = GitHub()
    outcome = decide(github.runs(), since, now)
    logging.info(outcome['message'])
    if outcome['action'] != 'rerun':
        return 0

    accounts = ready_accounts()
    if accounts == 'paused':
        logging.info('自动阅读计划已暂停，不补跑')
        return 0
    if accounts == []:
        logging.warning('没有可用账户，已跳过补跑')
        report('微信读书 · 自动检测\n'
               f'检测周期：{since:%Y-%m-%d %H:%M} UTC\n'
               f'{outcome["message"]}，但没有可运行的账户（已关闭或需要重新扫码绑定）。\n'
               '请打开控制台重新绑定账户。', is_success=False)
        return 0

    ref = os.getenv('GITHUB_REF_NAME') or 'main'
    try:
        github.dispatch(ref)
    except RuntimeError as exc:
        logging.error('补跑触发失败：%s', exc)
        report(f'微信读书 · 自动检测失败\n{outcome["message"]}，自动补跑也没能启动（{exc}）。', is_success=False)
        return 1
    count = len(accounts) if accounts else 0
    logging.info('已触发一次补跑（ref=%s，%d 个账户）', ref, count)
    report('微信读书 · 自动检测补跑\n'
           f'检测周期：{since:%Y-%m-%d %H:%M} UTC\n'
           f'{outcome["message"]}，已自动重新发起一次阅读任务'
           f'（{"约 " + str(count) + " 个可用账户" if count else "账户数量未知，以实际运行为准"}）。\n'
           '本次任务由自动检测触发，稍后可在 Actions 或控制台运行记录中查看结果。')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyError as exc:
        logging.error('缺少环境变量 %s，无法查询或触发工作流', exc)
        sys.exit(1)
    except Exception as exc:
        logging.error('自动检测执行失败（%s：%s）', type(exc).__name__, exc if type(exc) is RuntimeError else '')
        sys.exit(1)
