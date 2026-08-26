"""基因回路建模工具 — BioCRNpyler 回路编译 + Bioscrape 动力学仿真

biocrnpyler / bioscrape / networkx / python-libsbml / bokeh 均为第二层依赖
（src/extra-deps.js EXTRA_DEPS），首次调用由 TS 侧 ensureExtraDeps 自动安装；
此处 import 失败时返回 needs_install 兜底。

注意：biocrnpyler 必须以 --no-deps 安装（其 fa2-modified 依赖需要 C++ 编译，
Windows 无预编译 wheel）；fa2 只用于力导向布局，缺失不影响编译与仿真。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _build_part(comp):
    """组件描述 dict → biocrnpyler DNA part 对象。"""
    from biocrnpyler.components.dna import (
        CDS, Promoter, RBS, Terminator, RegulatedPromoter,
    )
    ctype = str(comp.get('type', '')).lower()
    name = str(comp.get('name') or '')
    if not name:
        raise ValueError(f'组件缺 name: {comp}')
    if ctype == 'promoter':
        regulators = comp.get('regulators') or []
        if regulators:
            return RegulatedPromoter(name, regulators=[str(r) for r in regulators],
                                     leak=bool(comp.get('leak', True)))
        return Promoter(name)
    if ctype == 'rbs':
        return RBS(name)
    if ctype == 'cds':
        return CDS(name, str(comp.get('protein', name)))
    if ctype == 'terminator':
        return Terminator(name)
    raise ValueError(f'未知组件类型: {ctype}（支持 promoter/rbs/cds/terminator）')


def op_circuit_compile(args):
    """基因回路编译（BioCRNpyler）：组件列表 → CRN → SBML 模型 + 网络统计 + 拓扑图。

    返回 sbml_file 路径（供 op_circuit_simulate 使用）、物种/反应数、networkx
    二部图 PNG（species↔reaction 二分网络）。
    """
    try:
        from biocrnpyler import DNA_construct, TxTlExtract, ExpressionExtract
    except ImportError:
        return {'error': 'biocrnpyler 未安装，正在自动安装…（若仍未就绪请运行 uv pip install biocrnpyler bioscrape networkx python-libsbml）',
                'needs_install': True}

    components = args.get('components') or []
    if not components:
        raise ValueError('components 必填（[{type: promoter/rbs/cds/terminator, name, regulators?, ...}]）')

    name = str(args.get('name', 'circuit'))
    context = str(args.get('context', 'txtl_extract')).lower()

    parts = [_build_part(c) for c in components]
    construct = DNA_construct(parts, name=name)

    if context in ('txtl_extract', 'txtl'):
        extract = TxTlExtract(name='txtl', components=[construct])
    elif context == 'expression':
        extract = ExpressionExtract(name='expr', components=[construct])
    else:
        raise ValueError(f'context 仅支持 txtl_extract / expression，收到: {context}')

    crn = extract.compile_crn()

    out_file = args.get('out_file') or os.path.join(os.getcwd(), f'{name}.xml')
    crn.write_sbml_file(out_file)

    # networkx 二部图：species 节点 ↔ reaction 节点
    network_plot = None
    try:
        import networkx as nx
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        g = nx.Graph()
        species_ids = [str(s) for s in crn.species]
        for s in species_ids:
            g.add_node(s, bipartite=0)
        for i, rxn in enumerate(crn.reactions):
            rid = f'r{i}'
            g.add_node(rid, bipartite=1)
            for inp in rxn.inputs:
                g.add_edge(str(inp.species), rid)
            for outp in rxn.outputs:
                g.add_edge(rid, str(outp.species))

        fig, ax = plt.subplots(figsize=(12, 8))
        pos = nx.spring_layout(g, seed=42, k=2.0)
        sp_nodes = [n for n, d in g.nodes(data=True) if d['bipartite'] == 0]
        rx_nodes = [n for n, d in g.nodes(data=True) if d['bipartite'] == 1]
        nx.draw_networkx_nodes(g, pos, nodelist=sp_nodes, node_color='#6baed6',
                               node_size=300, ax=ax)
        nx.draw_networkx_nodes(g, pos, nodelist=rx_nodes, node_color='#fd8d3c',
                               node_size=80, node_shape='s', ax=ax)
        nx.draw_networkx_edges(g, pos, alpha=0.4, ax=ax)
        labels = {n: (n[:20] + '…' if len(n) > 20 else n) for n in sp_nodes}
        nx.draw_networkx_labels(g, pos, labels=labels, font_size=7, ax=ax)
        ax.set_title(f'{name} CRN ({len(crn.species)} species / {len(crn.reactions)} reactions)')
        ax.axis('off')
        network_plot = os.path.splitext(out_file)[0] + '_network.png'
        fig.savefig(network_plot, bbox_inches='tight', dpi=200)
        plt.close(fig)
    except Exception as e:
        network_plot = None
        network_note = f'网络图绘制失败（不影响 SBML 产物）: {e}'
    else:
        network_note = None

    result = {
        'sbml_file': os.path.abspath(out_file),
        'n_species': len(crn.species),
        'n_reactions': len(crn.reactions),
        'context': context,
        'construct': name,
        'species_preview': [str(s) for s in list(crn.species)[:10]],
    }
    if network_plot:
        result['network_plot'] = os.path.abspath(network_plot)
    if network_note:
        result['network_note'] = network_note
    result['note'] = 'SBML 模型可直接传给 op_circuit_simulate 做 ODE/SSA 动力学仿真。'
    return result


def op_circuit_simulate(args):
    """回路动力学仿真（Bioscrape）：SBML → ODE/SSA 时间序列 + 曲线图 + 稳态/峰值。"""
    try:
        from bioscrape.sbmlutil import import_sbml
        from bioscrape.simulator import py_simulate_model
        import numpy as np
    except ImportError:
        return {'error': 'bioscrape 未安装，正在自动安装…（若仍未就绪请运行 uv pip install bioscrape）',
                'needs_install': True}

    sbml_file = args.get('sbml_file')
    if not sbml_file:
        raise ValueError('sbml_file 必填（op_circuit_compile 的 SBML 输出路径）')
    if not os.path.exists(sbml_file):
        return {'error': f'SBML 文件不存在: {sbml_file}'}

    sim_type = str(args.get('simulation_type', 'ode')).lower()
    if sim_type not in ('ode', 'ssa'):
        raise ValueError(f'simulation_type 仅支持 ode / ssa，收到: {sim_type}')

    tp = args.get('timepoints') or {}
    if isinstance(tp, list):
        timepoints = np.array(tp, dtype=float)
    elif isinstance(tp, (int, float)):
        # 容错：agent 常把「点数」直接传成数字（tools.md 示例即如此）——
        # 按总时长 [0, tp] 均分 200 点，而非裸 AttributeError
        timepoints = np.linspace(0.0, float(tp), 200)
    else:
        if not isinstance(tp, dict):
            raise ValueError(f'timepoints 须为 {{start,end,points}} 对象、数字（总时长）或列表，收到: {type(tp).__name__}')
        timepoints = np.linspace(float(tp.get('start', 0)),
                                 float(tp.get('end', 200)),
                                 int(tp.get('points', 200)))

    model = import_sbml(sbml_file)

    # 参数覆盖（可选）：{参数名: 值}
    overridden = []
    for k, v in (args.get('parameter_overrides') or {}).items():
        try:
            model.set_parameter(k, float(v))
            overridden.append(k)
        except Exception:
            pass

    result = py_simulate_model(timepoints, Model=model, stochastic=(sim_type == 'ssa'))
    df = result  # return_dataframe=True 默认

    # 统计：稳态值（末时间点）与峰值时间；跳过 time 列
    species_cols = [c for c in df.columns if c != 'time']
    steady = {}
    peaks = {}
    for c in species_cols:
        series = df[c].astype(float)
        steady[c] = round(float(series.iloc[-1]), 6)
        peaks[c] = round(float(df['time'].iloc[int(series.idxmax())])
                         if series.idxmax() in df.index else float('nan'), 4)

    # 曲线图：默认画浓度峰值最高的前 8 个物种
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    top = sorted(species_cols, key=lambda c: df[c].max(), reverse=True)[:8]
    fig, ax = plt.subplots(figsize=(10, 6))
    for c in top:
        label = c if len(c) <= 30 else c[:27] + '…'
        ax.plot(df['time'], df[c], label=label)
    ax.set_xlabel('Time')
    ax.set_ylabel('Concentration')
    ax.set_title(f'{os.path.basename(sbml_file)} — {sim_type.upper()} simulation')
    ax.legend(fontsize=7, loc='best')
    plot_file = args.get('out_file') or os.path.splitext(sbml_file)[0] + f'_{sim_type}.png'
    fig.savefig(plot_file, bbox_inches='tight', dpi=200)
    plt.close(fig)

    return {
        'sbml_file': os.path.abspath(sbml_file),
        'simulation_type': sim_type,
        'n_timepoints': len(df),
        'n_species': len(species_cols),
        'steady_state': steady,
        'peak_times': peaks,
        'plotted_species': top,
        'plot_file': os.path.abspath(plot_file),
        'overridden_parameters': overridden,
        'note': 'steady_state 为末时间点浓度；peak_times 为各物种达峰时间。'
                '曲线图默认只画峰值最高的前 8 个物种。',
    }
