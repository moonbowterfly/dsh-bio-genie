"""DNA/质粒设计工具 — 组装策略 + 质粒图谱"""
import sys
import json
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def op_assembly_design(args):
    """组装策略设计：输入片段列表，推荐组装方法并计算接头/overhang。"""
    from Bio.Seq import Seq

    fragments = args.get('fragments', [])
    method = args.get('method', 'auto')  # auto | gibson | golden_gate | restriction
    vector = args.get('vector', None)  # 可选载体序列

    if not fragments or len(fragments) < 2:
        return {'error': 'at least 2 fragments required'}

    # 计算总长度
    total_len = sum(len(f) for f in fragments)
    frag_info = []
    for i, seq in enumerate(fragments):
        s = seq.upper().replace(' ', '')
        frag_info.append({
            'index': i,
            'id': f'fragment_{i+1}',
            'length': len(s),
            'gc': round(sum(1 for c in s if c in 'GC') / len(s) * 100, 1) if s else 0,
            'sequence_preview': s[:30] + ('...' if len(s) > 30 else ''),
        })

    # 自动推荐方法
    if method == 'auto':
        if total_len < 15000 and len(fragments) <= 6:
            method = 'gibson'
        elif len(fragments) > 6:
            method = 'golden_gate'
        else:
            method = 'restriction'

    result = {
        'method': method,
        'n_fragments': len(fragments),
        'total_length': total_len,
        'fragments': frag_info,
    }

    if method == 'gibson':
        # 设计 Gibson Assembly 接头（15-40bp overlap）
        overlap_len = 20
        overlaps = []
        for i in range(len(fragments) - 1):
            fwd_end = fragments[i][-overlap_len:].upper().replace(' ', '')
            rev_start = fragments[i + 1][:overlap_len].upper().replace(' ', '')
            overlaps.append({
                'between': f'fragment_{i+1}_fragment_{i+2}',
                'overlap_length': overlap_len,
                'sequence': fwd_end,
                'note': '5\' 端 fragment 的 3\' 与下一个 fragment 的 5\' 重叠',
            })
        result['overlaps'] = overlaps
        result['protocol'] = {
            'name': 'Gibson Assembly',
            'enzymes': 'Gibson Assembly Master Mix (NEB E2621)',
            'temperature': '50°C',
            'time': '60 min (1-4 fragments) or overnight (>4 fragments)',
            'notes': '碎片等摩尔混合；总长度 <15kb 效率最高；建议 3:1 插入:载体摩尔比',
        }

    elif method == 'golden_gate':
        # 设计 Golden Gate overhangs（4bp scarless）
        overhangs = []
        for i in range(len(fragments) - 1):
            # 从每个片段末端取 4bp 作为 overhang
            end_4bp = fragments[i][-4:].upper().replace(' ', '') if len(fragments[i]) >= 4 else 'NNNN'
            overhangs.append({
                'position': f'junction_{i+1}',
                'overhang': end_4bp,
                'enzyme': 'BsaI (GCTCTTC)',
            })
        result['overhangs'] = overhangs
        result['protocol'] = {
            'name': 'Golden Gate Assembly',
            'enzymes': 'BsaI (Type IIS) + T4 DNA Ligase',
            'temperature': '37°C digestion + 16°C ligation (cycling)',
            'time': '25-50 cycles',
            'notes': '每个片段两端加 BsaI 位点；overhangs 必须唯一；可同时组装 >10 个片段',
        }

    elif method == 'restriction':
        result['protocol'] = {
            'name': 'Restriction-Ligation Cloning',
            'enzymes': '选择合适的限制酶 + T4 DNA Ligase',
            'notes': '需确保片段内部无酶切位点；建议双酶切提高定向性',
        }
        result['note'] = '限制酶克隆需手动选择酶；运行 bio_seq_restriction 检查位点可用性'

    return result


def op_plasmid_map(args):
    """质粒图谱：输入特征列表，生成文本格式的质粒注释图。"""
    features = args.get('features', [])
    name = args.get('name', 'plasmid')
    total_size = args.get('size', None)

    if not features:
        return {'error': 'features list required (e.g. [{"name":"promoter","start":0,"end":200,"type":"regulatory"}])'}

    # 构建图谱
    max_pos = total_size or max(f.get('end', 0) for f in features)
    scale = 60  # 每行显示的碱基数

    # 按位置排序
    features_sorted = sorted(features, key=lambda x: x.get('start', 0))

    # 特征类型颜色符号
    type_symbols = {
        'regulatory': '═══',  # 启动子等调控元件
        'cds': '═══',         # 编码序列
        'origin': '─ ─ ─',   # 复制起点
        'marker': '▓▓▓',     # 筛选标记
        'reporter': '░░░',   # 报告基因
        'other': '───',
    }

    # 文本图谱
    map_lines = [
        f'╔══ {name} ({max_pos} bp) ══╗',
        '',
    ]

    for feat in features_sorted:
        start = feat.get('start', 0)
        end = feat.get('end', 0)
        feat_type = feat.get('type', 'other')
        feat_name = feat.get('name', '?')
        direction = feat.get('direction', '+')
        symbol = type_symbols.get(feat_type, '───')
        arrow = '→' if direction == '+' else '←'
        size = end - start

        map_lines.append(
            f'  {start:>6}..{end:<6} │{symbol}│ {arrow} {feat_name} ({feat_type}, {size}bp)'
        )

    # 统计
    total_feature_bp = sum(f.get('end', 0) - f.get('start', 0) for f in features)
    remaining = max_pos - total_feature_bp

    map_lines.extend([
        '',
        f'  未注释区域: {remaining} bp ({round(remaining/max_pos*100, 1)}%)',
        f'  特征总数: {len(features)}',
        f'  总大小: {max_pos} bp',
        '',
        '╚' + '═' * 40 + '╝',
        '',
        '特征列表:',
    ])

    for i, feat in enumerate(features_sorted, 1):
        arrow = '→' if feat.get('direction', '+') == '+' else '←'
        map_lines.append(
            f'  {i}. {feat.get("name", "?")} [{feat.get("type", "?")}] {feat.get("start")}-{feat.get("end")} {arrow}'
        )

    return {
        'name': name,
        'size': max_pos,
        'features': features_sorted,
        'n_features': len(features),
        'feature_bp': total_feature_bp,
        'unannotated_bp': remaining,
        'map_text': '\n'.join(map_lines),
    }
