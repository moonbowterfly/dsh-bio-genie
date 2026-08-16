# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E 第五轮:协议库加载验证(双序列比对任务)。"""
import json
import sys
import time

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

dsh = DshClient('http://127.0.0.1:3080/api', timeout=60)
sid = dsh.create_session()
print('[e2e] session:', sid)

task = ('请对这两条序列做双序列比对并报告一致度和差异位点: '
        '序列1 = ATGAAACGCATTAGCACCACCATTACCAC, 序列2 = ATGAAACGTATTAGCACTACCATTACGAC。'
        '先加载对应的协议 skill 再执行。')
dsh.send(sid, task)

last = None
stable = 0
deadline = time.time() + 360
while time.time() < deadline:
    time.sleep(10)
    hv = dsh.history(sid, max_messages=100)
    text = dsh.extract_latest_text(hv)
    if text and text == last:
        stable += 1
        if stable >= 3:
            break
    else:
        stable = 0
        if text:
            last = text
            print(f'  ...最新回复 {len(text)} 字符')

calls = [ev['event']['data'] for ev in hv.get('events', []) if ev.get('event', {}).get('type') == 'tool/call']
print('\n[证据] 工具调用序列:')
for c in calls:
    print('  ', c.get('name'), str(c.get('arguments'))[:100])

print('\n=== 最终回复 ===')
print((last or '(无回复)')[:900])
