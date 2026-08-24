"""合成生物学 Phase 1 工具 — primer3 引物设计 / DNA Chisel 多约束优化 / pydna 克隆模拟

所有第三方依赖均为**函数体内懒加载**：模块导入失败时返回带安装提示的
error 字典，不影响 bio_ops.py 其余 op 的加载。

- primer3-py / dnachisel：第一层内置依赖（requirements.txt），缺失多半是
  环境未补装，提示 bio_env reinstall。
- pydna：第二层按需依赖（src/extra-deps.js EXTRA_DEPS），TS 侧会在调用
  clone_simulate 前自动 uv pip install；此处仍兜底返回友好错误。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _clean_seq(seq):
    return ''.join(str(seq).upper().split())


def op_primer3_design(args):
    """工业级 PCR 引物设计（primer3-py）：模板 → 候选引物对（Tm/GC/二级结构评分）。

    与 op_primer_design（dna_design.py，Biopython 简单版）区分：本 op 走
    Primer3 热力学评分（发夹/自互补/二聚体 Tm + penalty 排序），适合
    需要可投稿级引物质量的场景。
    """
    try:
        import primer3
    except ImportError:
        return {'error': 'primer3-py 未安装，请运行 bio_env reinstall=true 或 uv pip install primer3-py'}

    sequence = _clean_seq(args.get('sequence', ''))
    if not sequence:
        raise ValueError('sequence 必填（模板 DNA 序列）')
    if len(sequence) < 40:
        raise ValueError(f'模板太短（{len(sequence)} bp），Primer3 至少需要 ~40 bp')

    primer_size = args.get('primer_size') or [18, 25]
    tm_range = args.get('tm_range') or [58, 65]
    gc_range = args.get('gc_range') or [40, 60]
    num_return = int(args.get('num_return', 5))

    seq_args = {
        'SEQUENCE_ID': str(args.get('name', 'target')),
        'SEQUENCE_TEMPLATE': sequence,
    }
    target_region = args.get('target_region')  # [start, length]（0-based）
    if target_region:
        start, length = int(target_region[0]), int(target_region[1])
        if not (0 <= start < len(sequence)) or length <= 0 or start + length > len(sequence):
            raise ValueError(f'target_region [{start}, {length}] 超出模板范围（{len(sequence)} bp）')
        seq_args['SEQUENCE_TARGET'] = [start, length]

    global_args = {
        'PRIMER_NUM_RETURN': num_return,
        'PRIMER_MIN_SIZE': int(primer_size[0]),
        'PRIMER_OPT_SIZE': int(sum(primer_size) / 2),
        'PRIMER_MAX_SIZE': int(primer_size[1]),
        'PRIMER_MIN_TM': float(tm_range[0]),
        'PRIMER_OPT_TM': round(sum(tm_range) / 2, 1),
        'PRIMER_MAX_TM': float(tm_range[1]),
        'PRIMER_MIN_GC': float(gc_range[0]),
        'PRIMER_MAX_GC': float(gc_range[1]),
        'PRIMER_MAX_HAIRPIN_TH': float(args.get('max_hairpin_tm', 47.0)),
        'PRIMER_MAX_SELF_ANY_TH': float(args.get('max_self_any_tm', 47.0)),
        'PRIMER_PRODUCT_SIZE_RANGE': [[max(60, len(sequence) // 4), len(sequence)]],
    }

    res = primer3.bindings.design_primers(seq_args, global_args)
    n = int(res.get('PRIMER_PAIR_NUM_RETURNED', 0))
    if n == 0:
        explain = res.get('PRIMER_LEFT_EXPLAIN', '') + ' | ' + res.get('PRIMER_RIGHT_EXPLAIN', '')
        return {'pairs': [], 'n_returned': 0,
                'note': f'Primer3 未找到满足约束的引物对，可放宽 tm/gc/size 范围。{explain.strip()}'}

    pairs = []
    for i in range(n):
        def g(key, idx=i):
            return res.get(f'PRIMER_LEFT_{idx}_{key}') if key else None
        left = res.get(f'PRIMER_LEFT_{i}_SEQUENCE', '')
        right = res.get(f'PRIMER_RIGHT_{i}_SEQUENCE', '')
        pairs.append({
            'rank': i + 1,
            'penalty': round(float(res.get(f'PRIMER_PAIR_{i}_PENALTY', 0)), 4),
            'product_size': int(res.get(f'PRIMER_PAIR_{i}_PRODUCT_SIZE', 0)),
            'left': {
                'sequence': left,
                'tm': round(float(res.get(f'PRIMER_LEFT_{i}_TM', 0)), 2),
                'gc_percent': round(float(res.get(f'PRIMER_LEFT_{i}_GC_PERCENT', 0)), 1),
                'hairpin_tm': round(float(res.get(f'PRIMER_LEFT_{i}_HAIRPIN_TH', 0)), 2),
                'self_any_tm': round(float(res.get(f'PRIMER_LEFT_{i}_SELF_ANY_TH', 0)), 2),
                'position': list(res.get(f'PRIMER_LEFT_{i}', [None, None])),
            },
            'right': {
                'sequence': right,
                'tm': round(float(res.get(f'PRIMER_RIGHT_{i}_TM', 0)), 2),
                'gc_percent': round(float(res.get(f'PRIMER_RIGHT_{i}_GC_PERCENT', 0)), 1),
                'hairpin_tm': round(float(res.get(f'PRIMER_RIGHT_{i}_HAIRPIN_TH', 0)), 2),
                'self_any_tm': round(float(res.get(f'PRIMER_RIGHT_{i}_SELF_ANY_TH', 0)), 2),
                'position': list(res.get(f'PRIMER_RIGHT_{i}', [None, None])),
            },
            'compl_any_tm': round(float(res.get(f'PRIMER_PAIR_{i}_COMPL_ANY_TH', 0)), 2),
            'compl_end_tm': round(float(res.get(f'PRIMER_PAIR_{i}_COMPL_END_TH', 0)), 2),
        })

    return {
        'pairs': pairs,
        'n_returned': n,
        'recommended': pairs[0] if pairs else None,
        'note': '按 Primer3 penalty 升序排列，rank 1 为推荐引物对；'
                'hairpin/self_any/compl Tm 越低越好（阈值见传入参数）。',
    }


def op_dna_optimize(args):
    """多约束 DNA 序列优化（DNA Chisel）：EnforceTranslation + CodonOptimize + 约束集。

    与 op_seq_optimize（dna_design.py，简单密码子替换）区分：本 op 是
    约束求解架构——同时满足去限制性位点/GC 窗口/禁用 motif 等多约束后再做
    密码子优化，并返回逐位点修改报告。
    """
    try:
        from dnachisel import (
            DnaOptimizationProblem, CodonOptimize, EnforceTranslation,
            EnforceGCContent, AvoidPattern,
        )
    except ImportError:
        return {'error': 'dnachisel 未安装，请运行 bio_env reinstall=true 或 uv pip install dnachisel'}

    dna = args.get('dna_sequence')
    protein = args.get('protein_sequence')
    host = str(args.get('host_organism', 'e_coli'))
    constraints = args.get('constraints') or {}
    do_codon_opt = bool(args.get('codon_optimize', True))

    if dna:
        dna = _clean_seq(dna)
    elif protein:
        # 反向翻译起点：先用最优密码子铺一条初始序列，再交给约束求解
        from dnachisel.biotools import reverse_translate
        dna = reverse_translate(_clean_seq(protein))
    else:
        raise ValueError('dna_sequence 与 protein_sequence 至少提供一个')

    cons = [EnforceTranslation()]  # 保持氨基酸序列不变
    gc_range = constraints.get('gc_range')
    if gc_range:
        cons.append(EnforceGCContent(mini=float(gc_range[0]) / 100,
                                     maxi=float(gc_range[1]) / 100,
                                     window=80))
    for enz in constraints.get('remove_restriction_sites') or []:
        try:
            from Bio.Restriction import RestrictionBatch
            batch = RestrictionBatch([enz])
            if len(batch) == 1:
                site = str(list(batch)[0].site)
                cons.append(AvoidPattern(site))
        except Exception:
            pass  # 未知酶名跳过，不阻塞优化
    for motif in constraints.get('avoid_motifs') or []:
        cons.append(AvoidPattern(_clean_seq(motif)))

    objectives = [CodonOptimize(species=host)] if do_codon_opt else []
    problem = DnaOptimizationProblem(sequence=dna, constraints=cons, objectives=objectives)
    problem.resolve_constraints()
    problem.optimize()

    optimized = str(problem.sequence)
    changes = sum(1 for a, b in zip(dna, optimized) if a != b) + abs(len(dna) - len(optimized))
    gc_new = sum(1 for c in optimized if c in 'GC') / len(optimized) * 100 if optimized else 0

    return {
        'optimized_sequence': optimized,
        'length': len(optimized),
        'gc_percent': round(gc_new, 2),
        'n_changes': changes,
        'change_rate': round(changes / len(dna) * 100, 2) if dna else 0,
        'constraints_satisfied': bool(problem.all_constraints_pass()),
        'host_organism': host,
        'note': 'EnforceTranslation 保证氨基酸序列不变；n_changes 为相对输入 DNA 的碱基修改数。',
    }


def op_clone_simulate(args):
    """克隆模拟（pydna）：gibson / golden_gate / restriction 三种方法的组装模拟。

    pydna 是第二层依赖——TS 侧 ensureExtraDeps 会在调用前自动安装；
    此处 import 失败时返回 needs_install 提示兜底。
    """
    try:
        from pydna.dseqrecord import Dseqrecord
        from pydna.assembly import Assembly
    except ImportError:
        return {'error': 'pydna 未安装，正在自动安装…（若仍未就绪请运行 uv pip install pydna）',
                'needs_install': True}

    backbone = _clean_seq(args.get('backbone', ''))
    inserts = args.get('inserts') or []
    method = str(args.get('method', 'gibson')).lower()
    if not backbone:
        raise ValueError('backbone（载体序列）必填')
    if not inserts:
        raise ValueError('inserts（插入片段列表 [{name, sequence}]）必填')
    if method not in ('gibson', 'golden_gate', 'restriction', 'ligation'):
        raise ValueError(f'method 仅支持 gibson/golden_gate/restriction/ligation，收到: {method}')

    fragments = [Dseqrecord(backbone, name='backbone', circular=True)]
    for i, ins in enumerate(inserts):
        seq = _clean_seq(ins.get('sequence', '') if isinstance(ins, dict) else ins)
        if not seq:
            raise ValueError(f'inserts[{i}] 缺 sequence')
        fragments.append(Dseqrecord(seq, name=(ins.get('name') if isinstance(ins, dict) else None)
                                    or f'insert_{i + 1}'))

    if method == 'gibson':
        # 需要片段间同源臂重叠；默认按 20bp 上限检测
        limit = int(args.get('overlap', 20))
        asm = Assembly(fragments, limit=limit)
        products = asm.assemble_circular()
        if not products:
            # 无重叠时给出设计建议而非裸失败
            return {
                'method': 'gibson',
                'feasible': False,
                'n_products': 0,
                'note': f'片段间未检测到 ≥{limit}bp 同源臂，无法直接组装。'
                        '请为每个片段设计重叠接头（可用 bio_assembly_design 生成 overlap 方案），'
                        '把接头序列并入片段 5\'/3\' 端后重试。',
            }
        product = products[0]
        return {
            'method': 'gibson',
            'feasible': True,
            'n_products': len(products),
            'product_length': len(product),
            'product_sequence': str(product.seq),
            'circular': True,
            'note': 'Gibson 环化组装成功；product_sequence 为预期产物（载体+全部插入片段）。',
        }

    # golden_gate / restriction / ligation：以可行性检查 + 方案输出为主
    enzymes = args.get('restriction_enzymes') or (['BsaI'] if method == 'golden_gate' else [])
    from Bio.Restriction import RestrictionBatch
    report = {'method': method, 'enzymes': enzymes, 'fragments': []}
    feasible = True
    for frag in fragments:
        entry = {'name': frag.name, 'length': len(frag)}
        if enzymes:
            try:
                batch = RestrictionBatch(enzymes)
                analysis = batch.search(frag.seq, linear=not frag.circular)
                entry['cut_sites'] = {str(e): sites for e, sites in analysis.items() if sites}
            except Exception as e:
                entry['cut_sites_error'] = str(e)
                feasible = False
        report['fragments'].append(entry)
    if method == 'golden_gate':
        # Golden Gate 要求插入片段内部无 Type IIS 位点
        for entry in report['fragments'][1:]:
            if entry.get('cut_sites'):
                entry['warning'] = '插入片段内部含 Type IIS 位点，需先做同义突变消除'
                feasible = False
        report['note'] = ('Golden Gate 需要各片段两端带 BsaI 位点 + 唯一 4bp overhang；'
                          '组装产物序列模拟建议走 gibson 路径或 bio_python 自定义 pydna 脚本。')
    else:
        report['note'] = ('限制酶克隆：确认各片段末端可被所选酶切割、内部无位点；'
                          '电泳模拟/产物序列可结合 bio_seq_restriction 与 bio_python 完成。')
    report['feasible'] = feasible
    return report
