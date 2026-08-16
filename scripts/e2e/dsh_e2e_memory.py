# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E 第四轮:会话记忆(失败→修复配对沉淀经验 + bio_memory 查询)。"""
import json
import sys
import time

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

dsh = DshClient('http://127.0.0.1:3080/api', timeout=60)
sid = dsh.create_session()
print('[e2e] session:', sid)


def run_task(label, prompt, max_sec=300):
    print(f'[{label}] 发送')
    dsh.send(sid, prompt)
    last = None
    stable = 0
    deadline = time.time() + max_sec
    while time.time() < deadline:
        time.sleep(10)
        text = dsh.extract_latest_text(dsh.history(sid, max_messages=100))
        if text and text == last:
            stable += 1
            if stable >= 3:
                return text
        else:
            stable = 0
            if text:
                last = text
                print(f'  ...最新回复 {len(text)} 字符')
    return last


# 任务1:ACR——失败→修复,顺带沉淀 NameError 经验
t1 = run_task('task1', '请用 bio_python 执行这段代码,先原样运行一次不要改: pritn("memory test")。若失败按提示修复后重新运行,最终告诉我输出。')
print('\n=== task1 回复 ===')
print((t1 or '(无回复)')[:300])

# 任务2:查错误修复经验
t2 = run_task('task2', '用 bio_memory 工具 action=lessons 查询错误修复经验,列出里面的条目。')
print('\n=== task2 回复 ===')
print((t2 or '(无回复)')[:600])

# 任务3:查成功模式
t3 = run_task('task3', '用 bio_memory 工具 action=patterns 查询成功代码模式,列出里面的条目。')
print('\n=== task3 回复 ===')
print((t3 or '(无回复)')[:600])
