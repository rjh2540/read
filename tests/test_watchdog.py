"""自动检测脚本的时间计算与补跑判定测试。"""
import unittest
from datetime import datetime, timezone

import watchdog


def run(event, status, conclusion, created):
    return {'event': event, 'status': status, 'conclusion': conclusion,
            'created_at': created.strftime('%Y-%m-%dT%H:%M:%SZ')}


class CronParse(unittest.TestCase):
    def test_reads_enabled_cron_only(self):
        # 注释掉的时段不算数，避免按未生效的时间判断。
        self.assertEqual(watchdog.cron_lines("  schedule:\n    - cron: '25 19 * * *'\n    #- cron: '0 21 * * *'"),
                         ['25 19 * * *'])

    def test_workflow_file_cron(self):
        # 不硬编码具体时刻：用户可在页面随时修改执行时间，这里只校验恰好解析出一条生效的每日 cron。
        lines = watchdog.cron_lines()
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r'^\d{1,2} \d{1,2} \* \* \*$')

    def test_last_fire_is_most_recent_utc_slot(self):
        now = datetime(2026, 11, 15, 4, 0, tzinfo=timezone.utc)
        self.assertEqual(watchdog.last_fire('25 19 * * *', now), datetime(2026, 11, 14, 19, 25, tzinfo=timezone.utc))
        # 刚好到点也算已经触发过，避免起点晚于任务记录。
        self.assertEqual(watchdog.last_fire('25 19 * * *', datetime(2026, 11, 14, 19, 25, tzinfo=timezone.utc)),
                         datetime(2026, 11, 14, 19, 25, tzinfo=timezone.utc))

    def test_multiple_slots_use_the_latest(self):
        now = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
        since, fallback = watchdog.window(['7 4 * * *', '25 19 * * *'], now)
        self.assertEqual((since, fallback), (datetime(2026, 11, 15, 4, 7, tzinfo=timezone.utc), False))

    def test_unsupported_cron_falls_back_to_24_hours(self):
        now = datetime(2026, 11, 15, 4, 0, tzinfo=timezone.utc)
        for cron in ['*/30 * * * *', '0 0 * * 1', 'bad', '']:
            with self.subTest(cron=cron):
                since, fallback = watchdog.window([cron], now)
                self.assertTrue(fallback)
                self.assertEqual(since, now - watchdog.timedelta(hours=24))


class Decide(unittest.TestCase):
    def setUp(self):
        self.since = datetime(2026, 11, 14, 19, 25, tzinfo=timezone.utc)
        # 默认基准超过 11 小时的“无记录等待期”，让补跑用例走完整判定。
        self.now = datetime(2026, 11, 15, 8, 0, tzinfo=timezone.utc)

    def decide(self, runs):
        return watchdog.decide(runs, self.since, self.now)

    def test_no_record_reruns(self):
        self.assertEqual(self.decide([])['action'], 'rerun')

    def test_failed_schedule_reruns(self):
        runs = [run('schedule', 'completed', 'failure', self.since)]
        self.assertEqual(self.decide(runs)['action'], 'rerun')

    def test_successful_schedule_waits(self):
        runs = [run('schedule', 'completed', 'success', self.since)]
        self.assertEqual(self.decide(runs)['action'], 'ok')

    def test_active_run_never_reruns(self):
        # 排队、等待审批、运行中都交给它自己完成，不重复触发。
        for status in ['queued', 'waiting', 'in_progress']:
            with self.subTest(status=status):
                runs = [run('schedule', status, None, self.since)]
                self.assertEqual(self.decide(runs)['action'], 'running')

    def test_manual_success_does_not_rerun(self):
        # 白天手动跑成功过，本周期时长已刷上，检测不应再补跑一次。
        runs = [run('schedule', 'completed', 'failure', self.since),
                run('workflow_dispatch', 'completed', 'success', self.since + watchdog.timedelta(hours=9))]
        outcome = self.decide(runs)
        self.assertEqual(outcome['action'], 'skipped')

    def test_grace_period_waits(self):
        now = self.since + watchdog.timedelta(seconds=60)
        outcome = watchdog.decide([], self.since, now)
        self.assertEqual(outcome['action'], 'waiting')

    def test_runs_before_window_are_ignored(self):
        # 昨天的成功记录不能顶替今天的失败。
        runs = [run('schedule', 'completed', 'success', self.since - watchdog.timedelta(days=1))]
        self.assertEqual(self.decide(runs)['action'], 'rerun')

    def test_unparsable_timestamp_is_ignored(self):
        self.assertEqual(self.decide([{'event': 'schedule', 'status': 'completed',
                                       'conclusion': 'success', 'created_at': 'not-a-date'}])['action'], 'rerun')


if __name__ == '__main__':
    unittest.main()
