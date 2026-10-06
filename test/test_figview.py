"""Sidecar acceptance: actual PNG centroids, every-point round trips and rejection mutations."""
import os
import sys
import subprocess
if not sys.flags.isolated:
    raise SystemExit(subprocess.run([sys.executable, '-I', '-B', __file__, *sys.argv[1:]]).returncode)

import copy
import itertools
import json
from pathlib import Path
import tempfile
import unittest

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from figurelib.figview import FigureBinding, FigviewError, canonical, export_bundle, sha256
from figurelib.figview_validate import (validate_bundle, data_to_pixel,
                                       pixel_to_data, hit_candidates)
from figurelib.differential_recipes import differential_plot
from figurelib.export_figure import export_figure

EVIDENCE = Path(os.environ.get('FIGVIEW_EVIDENCE_DIR', tempfile.mkdtemp(prefix='figview-evidence-')))
EVIDENCE.mkdir(parents=True, exist_ok=True)
REPORT = {'matplotlib': matplotlib.__version__, 'cases': [], 'rejections': [], 'schema_runs': []}


def table():
    return pd.DataFrame({'gene': ['dup', 'dup', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
                         'log2FC': [-3.3, -2.7, -1.7, -.55, .12, .6, 1.6, 2.5, 3.25],
                         'pvalue': [1e-3, 1e-5, 1e-7, .2, .6, .35, 1e-6, 1e-4, 1e-2],
                         'padj': [1e-3, 1e-5, 1e-7, .2, .6, .35, 1e-6, 1e-4, 1e-2]})


def make_binding():
    fig, ax, meta = differential_plot(table(), label_col='gene', top_k=0, viewer=True)
    return fig, ax, fig.figview_binding


class FigviewTests(unittest.TestCase):
    def tearDown(self):
        plt.close('all')

    def test_01_full_coordinate_matrix(self):
        # Entire Cartesian product, not a draw-before-save simulation.
        for xs, ys, inverted, tight, dpi in itertools.product(
                ['linear', 'log'], ['linear', 'log'], [False, True], [False, True], [100, 300, 600]):
            case = f'{xs}-{ys}-inv{int(inverted)}-tight{int(tight)}-dpi{dpi}'
            with self.subTest(case=case):
                fig, ax, binding = make_binding()
                # R1-sized opaque marker probes make raster centroids measurable at
                # 100 DPI as well. The bound source/coordinates/transforms stay intact.
                for b in binding.artists:
                    b['artist'].set_alpha(1)
                    b['artist'].set_sizes([30])
                    b['artist'].set_facecolor({'ns': '#ff0000', 'up': '#00ff00', 'down': '#0000ff'}[b['series_id']])
                ax.set_xscale(xs)
                ax.set_yscale(ys)
                ax.set_xlim((.08, 4) if xs == 'log' else (-4, 4))
                ax.set_ylim((.1, 9) if ys == 'log' else (0, 9))
                if inverted:
                    ax.invert_yaxis()
                manifest_path = Path(export_bundle(binding, EVIDENCE / 'matrix', figure_id=case,
                                      dpi=dpi, tight=tight, size_inches=(4.5, 3.5)))
                validation = validate_bundle(manifest_path)
                REPORT['schema_runs'].append({'manifest': str(manifest_path), **validation})
                manifest = json.loads(manifest_path.read_text())
                hits = json.loads((manifest_path.parent / manifest['hitmap']['path']).read_text())
                rows = json.loads((manifest_path.parent / manifest['data']['path']).read_text())
                self.assertEqual(validation['rows'], len(table()))
                self.assertEqual(validation['points'], 9 if xs == 'linear' else 5)
                self.assertEqual(len(hits['excluded']), 0 if xs == 'linear' else 4)
                axes = {a['axes_id']: a for a in hits['axes']}
                row_map = {r['row_id']: r for r in rows['rows']}
                pixels = np.asarray(Image.open(manifest_path.parent / manifest['image']['path']).convert('RGB'))
                forward = inverse = measured = unweighted = 0.0
                point_checks = []
                for hit in hits['elements']:
                    a = axes[hit['axes_id']]
                    center = np.asarray(hit['geometry']['center'])
                    xy = hit['plotted_values']
                    predicted = data_to_pixel(a, xy, hits['renderer_height'])
                    restored = pixel_to_data(a, center, hits['renderer_height'])
                    forward = max(forward, float(np.linalg.norm(predicted - center)))
                    inverse = max(inverse, float(np.linalg.norm(data_to_pixel(a, restored, hits['renderer_height']) - center)))
                    candidates = hit_candidates(hits, center)
                    self.assertTrue(any(h['row_ids'] == hit['row_ids'] for h in candidates))
                    raw = row_map[hit['row_ids'][0]]['values']
                    self.assertAlmostEqual(xy[0], raw['log2FC'])
                    self.assertAlmostEqual(xy[1], -np.log10(raw['padj']))
                    # Independent raster evidence: locate actual marker-color pixels
                    # inside its local square. No predicted center is used as a result.
                    b = next(b for b in binding.artists if b['series_id'] == hit['series_id'])
                    rgba = b['artist'].get_facecolors()[0]
                    target = np.round((rgba[:3] * rgba[3] + 1 - rgba[3]) * 255)
                    radius = int(np.ceil(hit['geometry']['radius'])) + 3
                    left, top = max(0, int(center[0]) - radius), max(0, int(center[1]) - radius)
                    crop = pixels[top:int(center[1]) + radius + 1, left:int(center[0]) + radius + 1]
                    mask = np.max(np.abs(crop.astype(float) - target), axis=2) <= 2
                    yy, xx = np.where(mask)
                    self.assertGreater(len(xx), 0)
                    pure_centroid = np.array([left + xx.mean() + .5, top + yy.mean() + .5])
                    unweighted = max(unweighted, float(np.linalg.norm(pure_centroid - center)))
                    # Coverage-weighted centroid includes antialiased edge pixels.
                    # Primary color chroma rejects white/gray text/threshold lines.
                    primary = int(np.argmax(target))
                    other = [j for j in range(3) if j != primary]
                    weight = np.maximum(crop[:, :, primary].astype(float) -
                                        np.max(crop[:, :, other], axis=2), 0) / 255
                    yy_grid, xx_grid = np.indices(weight.shape)
                    centroid = np.array([left + np.sum((xx_grid + .5) * weight) / weight.sum(),
                                         top + np.sum((yy_grid + .5) * weight) / weight.sum()])
                    error = float(np.linalg.norm(centroid - center))
                    measured = max(measured, error)
                    recovered = pixel_to_data(a, centroid, hits['renderer_height'])
                    self.assertLessEqual(np.linalg.norm(data_to_pixel(a, recovered, hits['renderer_height']) - center), 1)
                    self.assertTrue(any(h['row_ids'] == hit['row_ids'] for h in hit_candidates(hits, centroid)))
                    point_checks.append({'element_id': hit['element_id'], 'row_ids': hit['row_ids'],
                                         'plotted_values': xy, 'predicted_png_xy': center.tolist(),
                                         'measured_png_centroid': centroid.tolist(), 'raster_error_px': error,
                                         'pixel_to_row_pass': True})
                self.assertLessEqual(measured, 1)
                REPORT['cases'].append({'case': case, 'points': validation['points'],
                                        'max_data_to_pixel_error_px': forward,
                                        'max_pixel_roundtrip_error_px': inverse,
                                        'max_pure_pixel_centroid_error_px': unweighted,
                                        'point_checks': point_checks,
                                        'max_actual_png_centroid_error_px': measured})
                plt.close(fig)

    def test_02_r1_spike_raster(self):
        for mode in ['linear', 'log-inverted']:
            fig, ax = plt.subplots(figsize=(4, 3), dpi=100)
            xy = np.array([[1, 1], [3, 4], [7, 2]], float)
            artist = ax.scatter(*xy.T, c=['#ff0000', '#00ff00', '#0000ff'], s=30, edgecolors='none')
            if mode == 'log-inverted':
                ax.set_xscale('log')
                ax.invert_yaxis()
            ax.set_xlabel('source X'); ax.set_ylabel('source Y'); ax.set_title(mode)
            binding = FigureBinding(fig, pd.DataFrame(xy, columns=['x', 'y']))
            binding.bind_points(artist, series_id='points', row_groups=[[0], [1], [2]], plotted_values=xy)
            entry = Path(export_bundle(binding, EVIDENCE / 'r1', figure_id=mode, dpi=300))
            hits = json.loads((entry.parent / f'{mode}.hits.json').read_text())
            pixels = np.asarray(Image.open(entry.parent / f'{mode}.png').convert('RGB'))
            errors = []
            for hit, color in zip(hits['elements'], [(255, 0, 0), (0, 255, 0), (0, 0, 255)]):
                yy, xx = np.where(np.all(np.abs(pixels.astype(float) - color) < 5, axis=2))
                centroid = [xx.mean() + .5, yy.mean() + .5]
                errors.append(float(np.linalg.norm(np.asarray(centroid) - hit['geometry']['center'])))
                self.assertEqual(hit_candidates(hits, centroid)[0]['row_ids'], hit['row_ids'])
            self.assertLessEqual(max(errors), .05)
            REPORT.setdefault('r1_spike', []).append({'case': mode, 'max_actual_png_centroid_error_px': max(errors),
                                                     'validator': validate_bundle(entry)})

    def test_03_default_unchanged_and_recipe_export(self):
        fig0, ax0, meta0 = differential_plot(table(), label_col='gene', top_k=0)
        fig1, ax1, meta1 = differential_plot(table(), label_col='gene', top_k=0, viewer=True)
        self.assertEqual(meta0, meta1)
        self.assertFalse(hasattr(fig0, 'figview_binding'))
        paths0 = export_figure(fig0, str(EVIDENCE / 'old'), formats=['png'], dpi=300)
        paths1 = export_figure(fig1, str(EVIDENCE / 'optin'), formats=['png'], dpi=300)
        self.assertEqual(paths0, [str(EVIDENCE / 'old.png')])
        self.assertEqual(Path(paths0[0]).read_bytes(), Path(paths1[0]).read_bytes())
        out = EVIDENCE / 'recipe.png'
        fig, ax, meta = differential_plot(table(), label_col='gene', top_k=0, out_file=str(out),
                                            viewer={'figure_id': 'recipe', 'output_dir': str(EVIDENCE / 'recipe-bundles')})
        self.assertEqual(meta['exported_files'], [str(out)])
        REPORT['recipe_export'] = {'manifest': meta['viewer_manifest'], 'validator': validate_bundle(meta['viewer_manifest'])}
        self.assertEqual(REPORT['recipe_export']['validator']['points'], 9)

    def test_04_snapshot_revision_immutable_hash(self):
        fig, ax, binding = make_binding()
        entry = Path(export_bundle(binding, EVIDENCE / 'immutable', figure_id='immutable'))
        before = {p.name: p.read_bytes() for p in entry.parent.iterdir()}
        repeat = export_bundle(binding, EVIDENCE / 'immutable', figure_id='immutable')
        self.assertEqual(str(entry), repeat)
        self.assertEqual(before, {p.name: p.read_bytes() for p in entry.parent.iterdir()})
        ax.set_title('revision 2')
        entry2 = Path(export_bundle(binding, EVIDENCE / 'immutable', figure_id='immutable',
                                   parent_revision=json.loads(entry.read_text())['revision']))
        self.assertNotEqual(entry2, entry)
        self.assertEqual(before, {p.name: p.read_bytes() for p in entry.parent.iterdir()})
        # Old source mutation cannot alter captured rows.
        df = table()
        captured = FigureBinding(fig, df, id_column='gene')
        original = canonical(captured.rows)
        df.loc[0, 'gene'] = 'mutated'
        self.assertEqual(original, canonical(captured.rows))
        row_ids = [r['row_id'] for r in captured.rows['rows']]
        self.assertNotEqual(row_ids[0], row_ids[1])
        # Reorder plotted selection while retaining the original snapshot identities.
        artist = ax.scatter([3, 1], [2, 1])
        captured.bind_points(artist, series_id='sorted', row_groups=[[1], [0]], plotted_values=[[3, 2], [1, 1]])
        entry3 = Path(export_bundle(captured, EVIDENCE / 'sorted', figure_id='sorted'))
        hits = json.loads((entry3.parent / 'sorted.hits.json').read_text())
        self.assertEqual([h['row_ids'][0] for h in hits['elements']], [row_ids[1], row_ids[0]])
        # Mutated image invalidates an already committed manifest.
        (entry.parent / 'immutable.png').write_bytes(before['immutable.png'] + b'changed')
        with self.assertRaisesRegex(FigviewError, 'SHA-256'):
            validate_bundle(entry)
        (entry.parent / 'immutable.png').write_bytes(before['immutable.png'])

    def test_05_limits_and_preview(self):
        fig, ax = plt.subplots()
        binding = FigureBinding(fig)
        entry = export_bundle(binding, EVIDENCE / 'preview', figure_id='preview')
        result = validate_bundle(entry)
        self.assertEqual(result['capabilities']['inspect'], 'preview')
        self.assertEqual(result['capabilities']['reason'], 'no-source-table')
        REPORT['preview'] = {'manifest': entry, 'validator': result}
        # Real 10,001 eligible points; no monkey-patched point budget.
        xy = np.column_stack([np.arange(10001), np.ones(10001)])
        artist = ax.scatter(*xy.T)
        large = FigureBinding(fig, pd.DataFrame(xy, columns=['x', 'y']))
        large.bind_points(artist, series_id='large', row_groups=[[i] for i in range(10001)], plotted_values=xy)
        with self.assertRaisesRegex(FigviewError, '10001 > 10000') as error:
            export_bundle(large, EVIDENCE / 'reject', figure_id='point-limit')
        REPORT['rejections'].append({'kind': 'points', 'actual_points': 10001, 'message': str(error.exception)})
        self.assertFalse(list((EVIDENCE / 'reject').rglob('*.figview.json')))
        self.assertEqual(artist.get_urls(), [None])
        # Exact point budget is accepted with the same real collection/table.
        boundary = FigureBinding(fig, pd.DataFrame(xy, columns=['x', 'y']))
        boundary.bind_points(artist, series_id='boundary', row_groups=[[i] for i in range(10000)],
                             plotted_values=xy[:10000], point_indices=list(range(10000)))
        limit_entry = export_bundle(boundary, EVIDENCE / 'boundary', figure_id='boundary', dpi=100)
        limit_result = validate_bundle(limit_entry)
        self.assertEqual(limit_result['points'], 10000)
        REPORT['exact_point_budget'] = {'manifest': limit_entry, 'validator': limit_result}
        fig, ax, binding = make_binding()
        binding.provenance['oversize'] = 'x' * (8 * 1024 * 1024)
        with self.assertRaisesRegex(FigviewError, 'budget|8 MiB') as error:
            export_bundle(binding, EVIDENCE / 'reject', figure_id='json-limit')
        REPORT['rejections'].append({'kind': 'JSON', 'payload_bytes': 8 * 1024 * 1024, 'message': str(error.exception)})
        # Deterministic incompressible actual PNG, larger than the real 16 MiB cap.
        fig, ax = plt.subplots(figsize=(25, 25))
        noise = np.random.default_rng(7).integers(0, 256, (2500, 2500, 3), dtype=np.uint8)
        fig.figimage(noise, resize=False)
        binding = FigureBinding(fig)
        with self.assertRaisesRegex(FigviewError, '16 MiB') as error:
            export_bundle(binding, EVIDENCE / 'reject', figure_id='png-limit', dpi=100, tight=False)
        REPORT['rejections'].append({'kind': 'PNG', 'message': str(error.exception)})
        self.assertFalse(list((EVIDENCE / 'reject').rglob('*.figview.json')))

    def test_06_mask_clip_transparent_aggregate(self):
        fig, ax = plt.subplots()
        xy = np.array([[1, 1], [2, np.nan], [3, 3], [5, 5], [0, 1]])
        artist = ax.scatter(*xy.T, c=[(1, 0, 0, 1), (1, 0, 0, 1), (1, 0, 0, 0), (1, 0, 0, 1), (1, 0, 0, 1)], edgecolors='none')
        ax.set_xscale('log'); ax.set_xlim(.5, 4); ax.set_ylim(0, 4)
        df = pd.DataFrame({'raw': [1, 2, np.nan, np.inf, -np.inf],
                           'large_integer': pd.Series([2**63 - 1] * 5, dtype='int64'),
                           'date': pd.date_range('2026-01-01', periods=5),
                           'category': pd.Categorical(['a', 'b', 'a', 'b', 'a']),
                           'text': ['<script>never execute</script>'] * 5})
        binding = FigureBinding(fig, df, lineage={'filters': [], 'sort': [],
                                'aggregations': [{'function': 'mean', 'group_keys': ['category'], 'value': 1}]})
        binding.bind_points(artist, series_id='agg', row_groups=[[0, 1], [1], [2], [3], [4]], plotted_values=xy)
        entry = Path(export_bundle(binding, EVIDENCE / 'edge', figure_id='edge'))
        self.assertTrue(validate_bundle(entry)['valid'])
        hits = json.loads((entry.parent / 'edge.hits.json').read_text())
        self.assertEqual(len(hits['elements']), 2)
        self.assertEqual(len(hits['elements'][0]['row_ids']), 2)
        self.assertEqual({e['reason'] for e in hits['excluded']}, {'masked/nonfinite', 'transparent', 'outside-log-domain'})
        self.assertEqual(hit_candidates(hits, hits['elements'][1]['geometry']['center']), [])
        # Legend/colorbar are never registered or reverse-guessed.
        self.assertEqual({s['series_id'] for s in hits['series']}, {'agg'})

    def test_07_schema_security_and_coordinate_mutations(self):
        fig, ax, binding = make_binding()
        entry = Path(export_bundle(binding, EVIDENCE / 'mutations', figure_id='mutations'))
        manifest = json.loads(entry.read_text())
        original = {p.name: p.read_bytes() for p in entry.parent.iterdir()}
        hits_name = manifest['hitmap']['path']
        rows_name = manifest['data']['path']
        mutations = [
            ('version', lambda m, r, h: m.update(schema_version=2)),
            ('capability', lambda m, r, h: m['capabilities'].update(inspect='preview')),
            ('unsafe-path', lambda m, r, h: m['image'].update(path='../outside.png')),
            ('absolute-path', lambda m, r, h: m['image'].update(path='C:/outside.png')),
            ('unknown-key', lambda m, r, h: m.update(execute='danger')),
            ('raw-type', lambda m, r, h: r['rows'][0]['values'].update(log2FC='wrong')),
            ('row-id', lambda m, r, h: r['rows'][0].update(row_id='unstable')),
            ('dangling-row', lambda m, r, h: h['elements'][0].update(row_ids=['missing'])),
            ('geometry', lambda m, r, h: h['elements'][0]['geometry']['center'].__setitem__(0, 0)),
            ('matrix', lambda m, r, h: h['axes'][0]['affine'][0].__setitem__(0, 0)),
            ('dpi', lambda m, r, h: h.update(dpi=1)),
            ('dimensions', lambda m, r, h: m['image'].update(width=1)),
            ('scale', lambda m, r, h: h['axes'][0]['xscale'].update(base=10)),
        ]
        for name, mutation in mutations:
            m = copy.deepcopy(manifest)
            r = json.loads(original[rows_name]); h = json.loads(original[hits_name])
            mutation(m, r, h)
            rb, hb = canonical(r), canonical(h)
            (entry.parent / rows_name).write_bytes(rb); (entry.parent / hits_name).write_bytes(hb)
            m['data']['sha256'] = sha256(rb); m['hitmap']['sha256'] = sha256(hb)
            m['revision'] = sha256(canonical({k: v for k, v in m.items() if k != 'revision'}))
            entry.write_bytes(canonical(m))
            with self.subTest(mutation=name), self.assertRaises((FigviewError, ArithmeticError)):
                validate_bundle(entry)
            REPORT['rejections'].append({'kind': 'mutation', 'case': name})
        for name, data in original.items():
            (entry.parent / name).write_bytes(data)
        self.assertTrue(validate_bundle(entry)['valid'])
        artist = binding.artists[0]['artist']
        artist.set_offsets(np.asarray(artist.get_offsets()) + 1)
        with self.assertRaisesRegex(FigviewError, 'changed after binding'):
            export_bundle(binding, EVIDENCE / 'reject', figure_id='stale-binding')

    def test_08_file_snapshot_and_nondefault_log_bases(self):
        source_file = EVIDENCE / 'source.tsv'
        table().to_csv(source_file, sep='\t', index=False)
        original_hash = sha256(source_file.read_bytes())
        fig, ax, meta = differential_plot(str(source_file), label_col='gene', top_k=0, viewer=True)
        source_file.write_text('changed after plot', encoding='utf-8')
        ax.set_xscale('log', base=2)
        ax.set_yscale('log', base=100)
        ax.set_xlim(.08, 4); ax.set_ylim(.1, 9); ax.invert_xaxis(); ax.invert_yaxis()
        entry = Path(export_bundle(fig.figview_binding, EVIDENCE / 'source', figure_id='source'))
        m = json.loads(entry.read_text())
        rows = json.loads((entry.parent / m['data']['path']).read_text())
        self.assertEqual(rows['source']['file_sha256'], original_hash)
        self.assertEqual(rows['parser']['delimiter'], '\t')
        self.assertEqual(rows['rows'][0]['values']['gene'], 'dup')
        REPORT['file_source'] = {'manifest': str(entry), 'validator': validate_bundle(entry)}
        self.assertEqual(REPORT['file_source']['validator']['points'], 5)

    def test_09_export_sidecar_discovery(self):
        """fig_export 的 sidecar 发现：阳性（真实 bundle 同 stem）/ 阴性 / 结构不合格。"""
        import bio_ops
        d = EVIDENCE / 'sidecar-discovery'
        d.mkdir(parents=True, exist_ok=True)
        fig, _ax, _meta = differential_plot(table(), label_col='gene', top_k=0, viewer=True)
        entry = Path(export_bundle(fig.figview_binding, d / 'bundle', figure_id='sidecar-demo'))
        m = json.loads(entry.read_text())
        png = entry.parent / m['image']['path']
        self.assertTrue(png.is_file())
        self.assertEqual(os.path.splitext(png.name)[0], 'sidecar-demo')

        path, viewer = bio_ops._discover_figview_sidecar(str(png))
        self.assertEqual(path, str(entry))
        self.assertTrue(viewer['available'])
        self.assertEqual(viewer['figure_id'], 'sidecar-demo')
        self.assertEqual(viewer['schema_version'], 1)
        self.assertEqual(viewer['inspect'], 'points')

        out = bio_ops.op_fig_export({'paths': [str(png)]})
        self.assertTrue(out['results'][0]['viewer']['available'])
        self.assertEqual(out['results'][0]['viewer']['figure_id'], 'sidecar-demo')

        lonely = d / 'lonely.png'
        Image.new('RGB', (64, 64), 'white').save(lonely)
        self.assertEqual(bio_ops._discover_figview_sidecar(str(lonely)), (None, None))
        out2 = bio_ops.op_fig_export({'paths': [str(lonely)]})
        self.assertFalse(out2['results'][0]['viewer']['available'])

        bad = d / 'bad.png'
        Image.new('RGB', (64, 64), 'white').save(bad)
        (d / 'bad.figview.json').write_text('{"schema_version": 1}', encoding='utf-8')
        _p, viewer3 = bio_ops._discover_figview_sidecar(str(bad))
        self.assertFalse(viewer3['available'])
        self.assertIn('结构校验未通过', viewer3['reason'])
        REPORT['sidecar_discovery'] = {'ok': str(png), 'manifest': path, 'lonely': None}


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FigviewTests))
    REPORT['tests_run'] = result.testsRun
    REPORT['failures'] = len(result.failures)
    REPORT['errors'] = len(result.errors)
    REPORT['max_actual_png_centroid_error_px'] = max((c['max_actual_png_centroid_error_px'] for c in REPORT['cases']), default=None)
    REPORT['max_data_to_pixel_error_px'] = max((c['max_data_to_pixel_error_px'] for c in REPORT['cases']), default=None)
    REPORT['max_pixel_roundtrip_error_px'] = max((c['max_pixel_roundtrip_error_px'] for c in REPORT['cases']), default=None)
    report_path = EVIDENCE / 'acceptance.json'
    report_path.write_bytes(canonical(REPORT))
    print(f'FIGVIEW_EVIDENCE={report_path}')
    print(json.dumps({k: v for k, v in REPORT.items() if k not in ('cases', 'schema_runs')}, ensure_ascii=False))
    raise SystemExit(0 if result.wasSuccessful() else 1)
