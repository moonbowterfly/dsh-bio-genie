# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E:在 3080 实例验证 bio_enrichr 工具真实可用。

流程:建会话 → 发富集任务(明确要求用 bio_enrichr)→ 轮询历史
→ 提取工具调用证据 + 最终回复。
"""
import json
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

BASE = 'http://127.0.0.1:3080/api'
dsh = DshClient(BASE, timeout=60)

# 0) 插件加载探测(容错:方法不存在就跳过)
try:
    r = dsh.rpc('plugin.list', {})
    names = [p.get('name') or p.get('id') for p in r.get('result', {}).get('value', {}).get('items', [])]
    print('[probe] plugins:', json.dumps(names, ensure_ascii=False)[:400])
except Exception as e:
    print('[probe] plugin.list 不可用:', e)

sid = dsh.create_session()
print('[e2e] session:', sid)

task = ('请用 bio_enrichr 工具对基因列表 TP53, BRCA1, EGFR, MDM2, KRAS, PTEN 做 KEGG 通路富集分析'
        '(library=KEGG_2021_Human, top=5),列出结果并按 adjusted_p_value 升序解读。')
dsh.send(sid, task)
print('[e2e] task sent')

deadline = time.time() + 420
last_text = None
tool_evidence = []
while time.time() < deadline:
    time.sleep(12)
    hv = dsh.history(sid, max_messages=80)
    # 扫描事件中的工具调用证据
    for evt in hv.get('events', []):
        ev = evt.get('event', {})
        data = ev.get('data', {})
        # 工具调用一般以 chunk/block 形式出现
        s = json.dumps(data, ensure_ascii=False)
        if 'enrichr' in s.lower() and ev not in tool_evidence:
            # 只记录关键字段,避免刷屏
            keys = {}
            for k in ('name', 'type', 'toolName', 'input'):
                if k in data:
                    keys[k] = str(data[k])[:200]
            chunk = data.get('chunk', {})
            block = chunk.get('block', {})
            keys['block_type'] = block.get('type', '?')
            if isinstance(block.get('input'), dict):
                keys['block_input'] = json.dumps(block['input'], ensure_ascii=False)[:200]
            if isinstance(block.get('output'), str):
                keys['block_output_preview'] = block['output'][:250]
            tool_evidence.append((evt.get('seq', 0), keys))
    text = dsh.extract_latest_text(hv)
    if text and text != last_text:
        last_text = text
        print(f'[e2e] ...最新回复 {len(text)} 字符')
    phase = dsh.goal_phase(hv)
    # 无 goal 时用"回复稳定"判断结束:连续 3 次轮询文本不变且非空
    if text and text == last_text and phase is None:
        stable_count = getattr(dsh, '_stable', 0) + 1
        setattr(dsh, '_stable', stable_count)
        if stable_count >= 3:
            print('[e2e] 回复稳定,判定完成')
            break
    else:
        setattr(dsh, '_stable', 0)

print('\n=== 工具调用证据 ===')
if tool_evidence:
    for seq, keys in tool_evidence[:8]:
        print(f'  seq={seq} {json.dumps(keys, ensure_ascii=False)[:400]}')
else:
    print('  (未捕获到 bio_enrichr 调用证据)')

print('\n=== 最终回复 ===')
print((last_text or '(无回复)')[:2500])
