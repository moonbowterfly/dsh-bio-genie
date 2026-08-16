# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E 第三轮:ACR 自愈(needs_repair → 修复重试)+ bio_log 回溯。"""
import json
import sys
import time

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

dsh = DshClient('http://127.0.0.1:3080/api', timeout=60)
sid = dsh.create_session()
print('[e2e] session:', sid)


def wait_stable(max_sec=300):
    last = None
    stable = 0
    deadline = time.time() + max_sec
    while time.time() < deadline:
        time.sleep(10)
        hv = dsh.history(sid, max_messages=100)
        text = dsh.extract_latest_text(hv)
        if text and text == last:
            stable += 1
            if stable >= 3:
                return text, hv
        else:
            stable = 0
            if text:
                last = text
                print(f'  ...最新回复 {len(text)} 字符')
    return last, dsh.history(sid, max_messages=100)


# 任务 1:ACR —— 故意给错误代码,期望 needs_repair → 修复 → 成功
print('[task1] 发送(含拼写错误的代码)')
dsh.send(sid, '请用 bio_python 执行这段代码,不要自己改,先原样运行一次: pritn("hello from bio_python")。若失败请按提示修复后重新运行,最终告诉我输出。')
text1, hv1 = wait_stable()
print('\n=== 任务1最终回复 ===')
print((text1 or '(无回复)')[:600])

# 统计工具调用次数(应有 ≥2 次 bio_python:失败一次 + 修复一次)
calls = [ev['event']['data'] for ev in hv1.get('events', []) if ev.get('event', {}).get('type') == 'tool/call']
names = [c.get('name') for c in calls]
print('\n[证据] 工具调用序列:', names)
py_calls = [n for n in names if n == 'bio_python']
print(f'[证据] bio_python 调用次数: {len(py_calls)} (期望 >=2)')

# 任务 2:bio_log 回溯
print('\n[task2] 发送(查执行日志)')
dsh.send(sid, '用 bio_log 工具查询最近 10 条执行日志,列出刚才 bio_python 的执行记录(包括失败和成功的那次)。')
text2, hv2 = wait_stable()
print('\n=== 任务2最终回复 ===')
print((text2 or '(无回复)')[:800])
