"""Rendered geometry tests; run through the shared bench runner.

The isolated child keeps host PYTHONPATH out of the plugin plotting environment.
Use --evidence to print the acceptance examples with unmodified print_report.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if not sys.flags.isolated:
    raise SystemExit(subprocess.run([sys.executable, '-I', '-B', __file__, *sys.argv[1:]]).returncode)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from figurelib.visual_qa import audit_layout, print_report
from figurelib.differential_recipes import differential_plot


def new_issues(issues):
    return [(s, m) for s, m in issues if m.startswith(('用户文本互叠：', '图例遮数据：'))]


def legend_issues(issues):
    return [(s, m) for s, m in issues if m.startswith('图例遮数据：')]


def significant_hits(ax):
    """Independent evidence that the recipe legend covers colored sig points."""
    legend = ax.get_legend().get_window_extent(ax.figure.canvas.get_renderer())
    count = 0
    for collection in ax.collections[1:]:  # colored down/up layers, excluding gray
        pixels = collection.get_offset_transform().transform(collection.get_offsets())
        count += int(np.sum((pixels[:, 0] > legend.x0 + 1) & (pixels[:, 0] < legend.x1 - 1)
                            & (pixels[:, 1] > legend.y0 + 1) & (pixels[:, 1] < legend.y1 - 1)
                            & (pixels[:, 1] >= ax.bbox.y0) & (pixels[:, 1] <= ax.bbox.y1)))
    return count


def volcano_fixture(variant=0):
    """All corners populated; rare high-p outliers trigger recipe's existing cap.

    20,000 background/sig points fix q999 near 10. A few dense significant
    points remain in the upper corner below the capped ylim; 'best' still hides
    them. Variants shift/skew the effect distribution without changing p values.
    """
    rng = np.random.default_rng(83)
    effects = rng.uniform(-5, 5, 20000)
    significance = rng.uniform(0, 10, len(effects))
    effects = np.r_[effects, np.linspace(-4.95, -4.65, 8), np.linspace(4.65, 4.95, 8), 0]
    significance = np.r_[significance, np.linspace(10.6, 11.2, 8),
                         np.linspace(10.6, 11.2, 8), 20]
    if variant == 1:
        effects = effects * 1.7 + 0.3
    elif variant == 2:
        effects = np.sign(effects) * (np.abs(effects) / 5) ** 2 * 5 - 0.2
    return pd.DataFrame({'log2FC': effects, 'pvalue': 10.0 ** -significance,
                         'padj': 10.0 ** -significance,
                         'baseMean': np.exp(np.linspace(2, 8, len(effects)))})


def dense_volcano_fixture():
    """Hermes R2 independent acceptance scene: default_rng(7), 8,000 points."""
    rng = np.random.default_rng(7)
    effect = np.clip(rng.normal(0, .55, 8000), -6, 6)
    p = np.clip(rng.uniform(0, 1, 8000) * np.exp(-1.5 * np.abs(effect)), 1e-300, 1)
    return pd.DataFrame({'log2FC': effect, 'pvalue': p})


def text_overlap_example():
    fig, ax = plt.subplots(figsize=(4, 3))
    ax.annotate('annotation A', (.5, .5), xycoords='axes fraction')
    ax.annotate('annotation B', (.52, .5), xycoords='axes fraction')
    return fig


def clean_demo_style():
    rng = np.random.default_rng(7)
    x = np.linspace(0, 10, 50)
    fig, ax = plt.subplots(figsize=(3.5, 2.625))
    ax.plot(x, np.sin(x) + rng.normal(0, .1, x.size), label='sin', marker='o', markersize=3)
    ax.plot(x, np.cos(x) + rng.normal(0, .1, x.size), label='cos', marker='s', markersize=3, ls='--')
    ax.set(xlabel='Time (s)', ylabel='Signal')
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.02), ncol=2, fontsize=6)
    fig.tight_layout()
    return fig


class LayoutTests(unittest.TestCase):
    def tearDown(self):
        plt.close('all')

    def test_annotations_report_text_pair_and_pixels(self):
        issues = new_issues(audit_layout(text_overlap_example()))
        self.assertEqual(len(issues), 1, issues)
        self.assertEqual(issues[0][0], 'WARN')
        for token in ('annotation A', 'annotation B', 'bbox=', 'px'):
            self.assertIn(token, issues[0][1])

    def test_clean_demo_style_has_no_new_false_positives(self):
        # Existing export demo's dimensions/line styles, with a clear legend.
        fig = clean_demo_style()
        self.assertEqual(audit_layout(fig), [])

    def test_existing_demo_clipping_and_ticks_unchanged(self):
        fig, ax = plt.subplots(figsize=(3, 2.2))
        ax.bar(range(12), np.random.default_rng(1).random(12))
        ax.set_xticks(range(12), [f'very_long_condition_name_{i}' for i in range(12)])
        ax.set_title('An intentionally overlong title that runs off the canvas edge')
        ax.set_ylabel('value')
        issues = audit_layout(fig)
        self.assertEqual(len(issues), 2, issues)
        self.assertIn('超出画布被裁切', issues[0][1])
        self.assertIn('1 个子图存在刻度标签重叠', issues[1][1])

    def test_missing_glyph_still_fails(self):
        fig, ax = plt.subplots()
        ax.set_title('\U0010ffff', fontfamily='DejaVu Sans')
        self.assertTrue(any(s == 'FAIL' and '缺字' in m for s, m in audit_layout(fig)))

    def test_legend_threshold_and_line_vertices(self):
        fig, ax = plt.subplots()
        ax.set(xlim=(0, 1), ylim=(0, 1))
        line, = ax.plot([.08, .09, .10], [.94, .95, .96], label='signal')
        ax.legend(loc='upper left')
        self.assertEqual(len(legend_issues(audit_layout(fig))), 1)
        self.assertEqual(legend_issues(audit_layout(fig, legend_min_points=4)), [])
        line.set_visible(False)
        self.assertEqual(legend_issues(audit_layout(fig)), [])
        with self.assertRaises(ValueError):
            audit_layout(fig, legend_min_points=0)

    def test_scatter_transform_mask_clipping_visibility_and_dedup(self):
        fig, ax = plt.subplots()
        ax.set(xlim=(1, 100), ylim=(0, 1), xscale='log')
        points = np.ma.array([[1.4, .94], [1.5, .95], [1.6, .96], [1.7, .97]],
                             mask=[[0, 0], [0, 0], [0, 0], [1, 1]])
        scatter = ax.scatter(*points.T, label='signal')
        ax.legend(loc='upper left')
        self.assertEqual(len(legend_issues(audit_layout(fig))), 1)
        self.assertEqual(legend_issues(audit_layout(fig, legend_min_points=4)), [])
        ax.scatter(*points.T)  # same points rendered twice must not double counts
        self.assertEqual(legend_issues(audit_layout(fig, legend_min_points=4)), [])
        for c in ax.collections:
            c.set_alpha(0)
        self.assertEqual(legend_issues(audit_layout(fig)), [])
        scatter.set_alpha(1)
        scatter.set_offsets([[1.4, 2], [1.5, 2], [np.nan, .9]])
        self.assertEqual(legend_issues(audit_layout(fig)), [])

    def test_figure_legend_and_per_point_visibility(self):
        fig, ax = plt.subplots()
        ax.set(xlim=(0, 1), ylim=(0, 1))
        scatter = ax.scatter([.08, .09, .1], [.94, .95, .96], label='signal',
                             c=[(1, 0, 0, 1), (1, 0, 0, 0), (1, 0, 0, 1)])
        fig.legend(loc='upper left', bbox_to_anchor=(0, 1), bbox_transform=ax.transAxes)
        self.assertEqual(legend_issues(audit_layout(fig)), [])
        scatter.set_facecolor('red')
        self.assertEqual(len(legend_issues(audit_layout(fig))), 1)

    def test_title_panel_label_and_legend_text_are_checked(self):
        fig, ax = plt.subplots()
        ax.set_title('Title')
        ax.plot([0, 1], [0, 1], label='legend entry')
        leg = ax.legend(loc='upper left')
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        for text in (ax.title, leg.get_texts()[0]):
            bb = text.get_window_extent(renderer)
            x, y = fig.transFigure.inverted().transform((bb.x0, bb.y0))
            fig.text(x, y, 'panel A', va='bottom')
        issues = new_issues(audit_layout(fig))
        self.assertTrue(any('Title' in m and 'panel A' in m for s, m in issues))
        self.assertTrue(any('legend entry' in m and 'panel A' in m for s, m in issues))

    def test_legend_internal_text_and_annotation_arrow_are_structural(self):
        fig, ax = plt.subplots()
        ax.plot([0, 1], [0, 1], label='first')
        ax.plot([0, 1], [1, 0], label='second')
        ax.legend(loc='upper left', title='legend', labelspacing=-.4)
        ax.annotate('left', (.1, .2), xytext=(.8, .2), arrowprops={'arrowstyle': '->'})
        ax.annotate('right', (.8, .2), xytext=(.1, .2), arrowprops={'arrowstyle': '->'})
        self.assertEqual(new_issues(audit_layout(fig)), [])

    def test_dpi_consistency(self):
        for dpi in (100, 200, 300):
            fig = text_overlap_example()
            fig.set_dpi(dpi)
            self.assertEqual(len(new_issues(audit_layout(fig))), 1)

    def test_verdict(self):
        for issues, verdict in (([], 'PASS'), ([('WARN', 'overlap')], 'WARN'),
                                ([('WARN', 'overlap'), ('FAIL', 'glyph')], 'FAIL')):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(print_report(issues), verdict)

    def test_recipe_best_reproduces_and_default_fixes_three_effect_distributions(self):
        for variant in range(3):
            with self.subTest(variant=variant):
                frame = volcano_fixture(variant)
                old_fig, old_ax, old_meta = differential_plot(frame, top_k=0, legend_loc='best')
                self.assertEqual(len(legend_issues(old_meta['layout_audit'])), 1)
                self.assertGreaterEqual(significant_hits(old_ax), 3)
                self.assertTrue(any('legend_loc' in s for s in old_meta['layout_suggestions']))
                fig, ax, meta = differential_plot(frame, top_k=0)
                self.assertEqual(new_issues(meta['layout_audit']), [])
                self.assertEqual(significant_hits(ax), 0)
                self.assertEqual(meta['layout_audit'], audit_layout(fig))
                self.assertEqual({k: v for k, v in meta.items() if not k.startswith('layout_')},
                                 {k: v for k, v in old_meta.items() if not k.startswith('layout_')})
                self.assertEqual(ax.get_xlim(), old_ax.get_xlim())
                self.assertEqual(ax.get_ylim(), old_ax.get_ylim())
                self.assertEqual(ax.get_position().bounds, old_ax.get_position().bounds)
                for old, new in zip(old_ax.collections, ax.collections):
                    np.testing.assert_array_equal(old.get_offsets(), new.get_offsets())
                    np.testing.assert_array_equal(old.get_facecolors(), new.get_facecolors())
                for old, new in zip(old_ax.lines, ax.lines):
                    np.testing.assert_array_equal(old.get_xydata(), new.get_xydata())

    def assert_visible_labels_fit(self, fig, ax, meta):
        self.assertEqual(new_issues(meta['layout_audit']), [], meta['layout_audit'])
        self.assertEqual(new_issues(audit_layout(fig)), [])
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        visible = [t for t in ax.texts if t.get_text() and t._check_xy(renderer)]
        self.assertGreater(len(visible), 0)  # never pass by dropping all labels
        for text in visible:
            box = text.get_window_extent(renderer)
            self.assertGreaterEqual(box.x0, ax.bbox.x0 - 1e-6)
            self.assertGreaterEqual(box.y0, ax.bbox.y0 - 1e-6)
            self.assertLessEqual(box.x1, ax.bbox.x1 + 1e-6)
            self.assertLessEqual(box.y1, ax.bbox.y1 + 1e-6)

    def test_dense_seed7_final_limits_and_three_default_label_variants(self):
        # Default top_k=5 is essential: the earlier top_k=0 examples could not
        # catch annotation × legend collisions. Exercise global jitter seeds too.
        scenes = [(f'dense-jitter-{seed}', dense_volcano_fixture(), seed) for seed in (0, 7, 19)]
        scenes += [(f'variant-{i}', volcano_fixture(i), 7) for i in range(3)]
        for name, frame, seed in scenes:
            with self.subTest(scene=name):
                np.random.seed(seed)
                fig, ax, meta = differential_plot(frame, effect_col='log2FC',
                                                   p_col='pvalue', mode='volcano')
                self.assert_visible_labels_fit(fig, ax, meta)
                self.assertGreater(len(meta['labeled']), 0)
                if name.startswith('dense'):
                    self.assertEqual((meta['n_sig_up'], meta['n_sig_down']), (91, 91))
                plt.close(fig)

    def test_static_fallback_keeps_annotations_out_of_legend_strip(self):
        with patch.dict(sys.modules, {'adjustText': None}):
            fig, ax, meta = differential_plot(dense_volcano_fixture())
        self.assert_visible_labels_fit(fig, ax, meta)

    def test_clipped_annotations_are_not_user_text_collisions(self):
        fig, ax = plt.subplots()
        ax.set(xlim=(0, 1), ylim=(0, 1))
        a = ax.annotate('hidden A', (.5, .5))
        b = ax.annotate('hidden B', (.5, .5))
        fig.canvas.draw()  # populate extents before these targets become clipped
        a.xy = (2, .5)
        b.xy = (2, .5)
        self.assertEqual(new_issues(audit_layout(fig)), [])
        a.set_annotation_clip(False)
        b.set_annotation_clip(False)
        # Put the text on the canvas while retaining an out-of-range target.
        a.set_anncoords('axes fraction')
        b.set_anncoords('axes fraction')
        a.set_position((.5, .5))
        b.set_position((.5, .5))
        self.assertEqual(len(new_issues(audit_layout(fig))), 1)

    def test_boundary_geometry_guard_updates_leaders(self):
        from figurelib.differential_recipes import _fit_annotations
        from matplotlib.patches import FancyArrowPatch
        fig, ax = plt.subplots()
        ax.set(xlim=(0, 1), ylim=(0, 1))
        a = ax.annotate('first', (.98, .98), ha='center')
        b = ax.annotate('second', (.98, .98), ha='center')
        arrow = FancyArrowPatch(b.get_position(), b.xy, patchA=b, transform=ax.transData)
        ax.add_patch(arrow)
        _fit_annotations(ax, [a, b], [arrow])
        self.assertNotEqual(tuple(b.get_position()), b.xy)
        self.assertEqual(tuple(arrow._posA_posB[0]), tuple(b.get_position()))
        self.assertEqual(tuple(arrow._posA_posB[1]), b.xy)
        self.assert_visible_labels_fit(fig, ax, {'layout_audit': audit_layout(fig)})

    def test_ma_and_no_significant_points_also_audited(self):
        frame = volcano_fixture()
        fig, ax, meta = differential_plot(frame, mode='ma', base_mean_col='baseMean', top_k=0)
        self.assertIn('layout_audit', meta)
        self.assertEqual(new_issues(meta['layout_audit']), [])
        frame['padj'] = 1
        fig, ax, meta = differential_plot(frame, top_k=0)
        self.assertIsNone(ax.get_legend())
        self.assertEqual(new_issues(meta['layout_audit']), [])

    def test_recipe_audits_before_export_and_returns_results(self):
        events = []
        def audit(fig):
            events.append('audit')
            return [('WARN', '图例遮数据：synthetic issue')]
        def export(fig, basename, **kwargs):
            events.append('export')
            return [basename + '.png']
        with tempfile.TemporaryDirectory() as tmp, \
                patch('figurelib.visual_qa.audit_layout', side_effect=audit), \
                patch('figurelib.export_figure.export_figure', side_effect=export), \
                patch('figurelib.repro_script.write_repro_bundle',
                      return_value={'script': 'repro.py', 'readme': 'README.md'}):
            fig, ax, meta = differential_plot(volcano_fixture(), top_k=0,
                                               out_file=str(Path(tmp) / 'volcano.png'))
        self.assertEqual(events, ['audit', 'export'])
        self.assertEqual(meta['layout_audit'], [('WARN', '图例遮数据：synthetic issue')])
        self.assertIn("legend_loc='outside'", meta['layout_suggestions'][0])


def evidence(out_dir=None):
    print('=== annotation overlap ===')
    print_report(audit_layout(text_overlap_example()))
    print('=== clean demo style ===')
    clean_issues = audit_layout(clean_demo_style())
    print(f'new_warnings={len(new_issues(clean_issues))}')
    print_report(clean_issues)
    print('=== recipe: loc=best -> default outside ===')
    for variant in range(3):
        for loc in ('best', 'outside'):
            fig, ax, meta = differential_plot(volcano_fixture(variant), top_k=0, legend_loc=loc)
            print(f'variant={variant} legend_loc={loc} '
                  f'legend_data_warnings={len(legend_issues(meta["layout_audit"]))} '
                  f'significant_points_inside={significant_hits(ax)}')
            print_report(meta['layout_audit'])
            if out_dir is not None:
                fig.savefig(out_dir / f'variant{variant}_{loc}.png', dpi=150, bbox_inches='tight')
                (out_dir / f'variant{variant}_{loc}.json').write_text(
                    json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
            plt.close(fig)


def r2_evidence(out_dir):
    """Real PNG exports with the default annotation budget, plus saved R1 comparison.

    Run --r2-evidence DIR after saving e1fde66's differential_recipes.py and
    visual_qa.py as DIR/baseline_differential_recipes.py and baseline_visual_qa.py.
    """
    import figurelib.visual_qa as qa
    def load(name):
        spec = importlib.util.spec_from_file_location(name, out_dir / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    old_recipe = load('baseline_differential_recipes')
    old_qa = load('baseline_visual_qa')
    scenes = [('dense', dense_volcano_fixture())]
    scenes += [(f'variant{i}', volcano_fixture(i)) for i in range(3)]
    results = []
    for name, frame in scenes:
        np.random.seed(7)
        with patch('figurelib.visual_qa.audit_layout', side_effect=old_qa.audit_layout):
            old_fig, old_ax, old_meta = old_recipe.differential_plot(
                frame, effect_col='log2FC', p_col='pvalue', mode='volcano')
        print(f'=== {name} before e1fde66 ===')
        print_report(old_meta['layout_audit'])
        old_fig.canvas.draw()
        old_renderer = old_fig.canvas.get_renderer()
        old_visible_count = sum(bool(t.get_text()) and t._check_xy(old_renderer) for t in old_ax.texts)
        old_fig.savefig(out_dir / f'{name}_before.png', dpi=150, bbox_inches='tight')
        np.random.seed(7)
        fig, ax, meta = differential_plot(frame, effect_col='log2FC', p_col='pvalue', mode='volcano',
                                           out_file=str(out_dir / f'{name}_after.png'))
        print(f'=== {name} after ===')
        print_report(meta['layout_audit'])
        assert new_issues(meta['layout_audit']) == []
        assert new_issues(qa.audit_layout(fig)) == []
        old_fields = {k: v for k, v in old_meta.items() if not k.startswith('layout_')}
        assert all(meta[k] == value for k, value in old_fields.items())
        assert ax.get_ylim() == old_ax.get_ylim()
        assert ax.get_position().bounds == old_ax.get_position().bounds
        assert len(ax.collections) == len(old_ax.collections)
        for old, new in zip(old_ax.collections, ax.collections):
            np.testing.assert_array_equal(old.get_offsets(), new.get_offsets())
            np.testing.assert_array_equal(old.get_facecolors(), new.get_facecolors())
        renderer = fig.canvas.get_renderer()
        visible_count = sum(bool(t.get_text()) and t._check_xy(renderer) for t in ax.texts)
        assert visible_count > 0 and visible_count == old_visible_count
        result = {'scene': name, 'before': old_meta['layout_audit'], 'after': meta['layout_audit'],
                  'text_overlaps_after': 0, 'legend_data_overlaps_after': 0,
                  'visible_annotations_before': old_visible_count,
                  'visible_annotations_after': visible_count, 'metadata_unchanged': True,
                  'scatter_and_axes_rectangle_unchanged': True,
                  'xlim_before': old_ax.get_xlim(), 'xlim_after': ax.get_xlim(),
                  'png': meta['out_file']}
        results.append(result)
        (out_dir / f'{name}_after.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                                   encoding='utf-8')
        plt.close('all')
    (out_dir / 'r2_acceptance.json').write_text(json.dumps(results, ensure_ascii=False, indent=2),
                                               encoding='utf-8')


def baseline_regression(baseline_dir):
    """Three real comparisons with saved 235ce1f modules, outside bench.

    Run --evidence --baseline-dir DIR; DIR contains baseline_visual_qa.py and
    baseline_differential_recipes.py saved before edits. Compare the existing
    visual_qa demo's full stdout and both existing recipe demo modes' original
    metadata and exact rendered PNG bytes with the legend hidden.
    """
    import figurelib.visual_qa as qa
    import figurelib.differential_recipes as recipes

    def load(name):
        spec = importlib.util.spec_from_file_location(name, baseline_dir / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    old_qa = load('baseline_visual_qa')
    old_recipes = load('baseline_differential_recipes')

    def qa_demo(module):
        output = io.StringIO()
        with patch.object(module, 'render_preview', return_value='preview.png'), \
                contextlib.redirect_stdout(output):
            module._demo()
        issues = module.audit_layout(plt.gcf())
        plt.close('all')
        return output.getvalue(), issues

    def recipe_demo(module):
        from adjustText import adjust_text
        snapshots = []
        draw = module.differential_plot
        def capture(*args, **kwargs):
            fig, ax, meta = draw(*args, **kwargs)
            old_issues = old_qa.audit_layout(fig)
            current_issues = qa.audit_layout(fig)
            current_old_issues = [i for i in current_issues if i not in new_issues(current_issues)]
            assert old_issues == current_old_issues
            if ax.get_legend() is not None:
                ax.get_legend().set_visible(False)
            buffer = io.BytesIO()
            fig.savefig(buffer, format='png', dpi=fig.dpi)
            snapshots.append({'mode': meta['mode'],
                              'meta': {k: v for k, v in meta.items() if not k.startswith('layout_')},
                              'image_sha256_without_legend': hashlib.sha256(buffer.getvalue()).hexdigest(),
                              'old_issues': old_issues})
            return fig, ax, meta
        np.random.seed(117)
        # adjustText defaults to a wall-clock limit. Compare the unchanged
        # algorithm with a fixed iteration budget so CPU load cannot change the
        # baseline's label positions. This override is only in this comparison.
        def deterministic_adjust(*args, **kwargs):
            return adjust_text(*args, **kwargs, time_lim=None, iter_lim=100)
        with patch.object(module, 'differential_plot', side_effect=capture), \
                patch('adjustText.adjust_text', side_effect=deterministic_adjust), \
                patch('figurelib.export_figure.export_figure', side_effect=lambda f, b, **k: [b + '.pdf']), \
                patch('figurelib.repro_script.write_repro_bundle',
                      return_value={'script': 'repro.py', 'readme': 'README.md'}), \
                contextlib.redirect_stdout(io.StringIO()):
            module._demo(str(baseline_dir / 'regression_demo'))
        return snapshots

    comparisons = []
    for run in range(1, 4):
        old_output, old_issues = qa_demo(old_qa)
        output, issues = qa_demo(qa)
        assert old_output == output and old_issues == issues
        old = recipe_demo(old_recipes)
        current = recipe_demo(recipes)
        assert old == current, [
            {'mode': a['mode'], 'differing_fields': [k for k in a if a[k] != b[k]]}
            for a, b in zip(old, current)]
        item = {'run': run, 'visual_qa_stdout_equal': True, 'visual_qa_issues': issues,
                'recipe_metadata_equal': True, 'recipe_images_equal_without_legend': True,
                'recipe_snapshots': current}
        comparisons.append(item)
        print(f'regression_run={run} visual_qa_stdout_equal=True recipe_meta_equal=True '
              'volcano/MA_png_equal_without_legend=True')
    (baseline_dir / 'regression.json').write_text(json.dumps(comparisons, ensure_ascii=False, indent=2),
                                                encoding='utf-8')


if __name__ == '__main__':
    if '--r2-evidence' in sys.argv:
        r2_evidence(Path(sys.argv[sys.argv.index('--r2-evidence') + 1]))
    elif '--evidence' in sys.argv:
        baseline_dir = (Path(sys.argv[sys.argv.index('--baseline-dir') + 1])
                        if '--baseline-dir' in sys.argv else None)
        evidence(baseline_dir)
        if baseline_dir is not None:
            baseline_regression(baseline_dir)
    else:
        unittest.main()
