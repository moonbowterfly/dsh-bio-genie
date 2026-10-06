#!/usr/bin/env python3
"""Circular map geometry and contract regression tests (plugin Python 3.12).

Run: node scripts/run-python-test.mjs test/test_plasmid_render.py
The geometry assertions use the actual Agg renderer's text bounding boxes,
not estimates or PNG file existence alone.
"""
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

if not sys.flags.isolated:
    # The shared bench runner intentionally inherits its environment. Keep this
    # plotting test in the plugin venv even when a host sets PYTHONPATH to Hermes.
    raise SystemExit(subprocess.run([sys.executable, '-I', '-B', __file__, *sys.argv[1:]]).returncode)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from dna_design_2 import _plasmid_graphic, op_plasmid_map
from plasmid_render import _build_figure, _load_map, _tick_positions

FIXTURE = ROOT / 'test' / 'fixtures' / 'pUC19_annotated.gb'


def scene_audit(fig, scene):
    """JSON-serializable evidence, also used by the external acceptance report."""
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    texts = [text for text in fig.findobj() if hasattr(text, 'get_text') and text.get_gid()]
    boxes = [(text.get_gid(), text.get_window_extent(renderer)) for text in texts]
    overlaps = [(a, b) for i, (a, box_a) in enumerate(boxes)
                for b, box_b in boxes[i + 1:] if box_a.overlaps(box_b)]
    clipped = [name for name, box in boxes if not (
        fig.bbox.x0 <= box.x0 <= box.x1 <= fig.bbox.x1 and
        fig.bbox.y0 <= box.y0 <= box.y1 <= fig.bbox.y1)]
    minimum = float('inf')
    for line in fig.axes[0].lines:
        if not (line.get_gid() or '').startswith('leader:'):
            continue
        points = list(zip(line.get_xdata(), line.get_ydata()))
        for (x, y), (u, v) in zip(points, points[1:]):
            dx, dy = u - x, v - y
            squared = dx * dx + dy * dy
            t = max(0, min(1, -(x * dx + y * dy) / squared)) if squared else 0
            minimum = min(minimum, math.hypot(x + t * dx, y + t * dy))
    labels = [text for text in texts if text.get_gid().startswith('label:')]
    return {'labels': len(labels), 'all_text_boxes': len(boxes),
            'text_box_overlaps': overlaps, 'clipped_text_boxes': clipped,
            'minimum_leader_radius': None if math.isinf(minimum) else minimum,
            'feature_outer_radius': 1.0, 'tick_outer_radius': 1.15,
            'label_texts': [text.get_text() for text in labels],
            'tick_step': scene['tick_step'], 'tracks': scene['tracks']}


class CircularMapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='genie_plasmid_')
        self.addCleanup(self.tmp.cleanup)

    def assert_geometry(self, args, features):
        fig, scene = _build_figure(args, features)
        self.addCleanup(fig.clear)
        audit = scene_audit(fig, scene)
        self.assertEqual(audit['text_box_overlaps'], [], audit)
        self.assertEqual(audit['clipped_text_boxes'], [], audit)
        if audit['minimum_leader_radius'] is not None:
            self.assertGreater(audit['minimum_leader_radius'], 1.25, audit)
        for text, feature in zip(audit['label_texts'], scene['features']):
            self.assertEqual(''.join(text.split()), ''.join(feature['name'].split()))
        return fig, scene, audit

    def test_fixture_geometry_and_metadata(self):
        fig, scene, audit = self.assert_geometry({'genbank_file': str(FIXTURE), 'name': 'pUC19'}, [])
        self.assertEqual(scene['length'], 2686)
        self.assertEqual(audit['labels'], 10)
        self.assertEqual(audit['tick_step'], 500)
        self.assertEqual(sum(f['name'] == 'pBR322' for f in scene['features']), 1)
        self.assertNotIn('source', [f['type'] for f in scene['features']])
        texts = {text.get_gid(): text.get_text() for text in fig.findobj()
                 if hasattr(text, 'get_text') and text.get_gid()}
        self.assertIn('GC 50.63%', texts['center:info'])
        self.assertIn('2,686 bp', texts['center:info'])
        self.assertIn('M77789.2', texts['source'])
        self.assertIn('0-based half-open', texts['source'])
        self.assertEqual(texts['center:name'], 'pUC19')
        for text in audit['label_texts']:
            self.assertNotIn('...', text)
        promoter = next(f for f in scene['features'] if f['name'].startswith('lac promoter'))
        mcs = next(f for f in scene['features'] if f['name'].startswith('MCS'))
        self.assertNotEqual(promoter['color'], mcs['color'])

    def test_dense_cluster_long_names_and_small_width(self):
        features = [{'name': f'feature {i}: ' + 'very-long-identifier-' * 4,
                     'start': 2 + i, 'end': 80 + i, 'type': 'cds',
                     'direction': '-' if i % 2 else '+'} for i in range(36)]
        _, _, audit = self.assert_geometry({'sequence': 'ATGC' * 750, 'figure_width': 5}, features)
        self.assertEqual(audit['labels'], 36)

    def test_all_quadrants_wrapped_reverse_and_point_features(self):
        features = [{'name': f'gene_{i}', 'start': i * 100, 'end': i * 100 + 60,
                     'type': 'cds', 'direction': '-' if i % 2 else '+'} for i in range(10)]
        features += [{'name': 'wrap', 'start': 950, 'end': 50, 'direction': '-'},
                     {'name': 'site', 'start': 500, 'end': 500, 'direction': '?'}]
        fig, scene, audit = self.assert_geometry({'sequence': 'ACGT' * 250}, features)
        self.assertEqual(audit['labels'], 12)
        wrap = next(f for f in scene['features'] if f['name'] == 'wrap')
        self.assertEqual(wrap['spans'], [(0, 50), (950, 1000)])
        self.assertEqual(wrap['midpoint'], 0)
        ids = [artist.get_gid() or '' for artist in fig.axes[0].patches]
        self.assertTrue(any(gid.endswith('strand:-1') for gid in ids))
        self.assertTrue(any(gid.endswith('strand:1') for gid in ids))
        self.assertTrue(any(gid.endswith('strand:0') for gid in ids))

    def test_dedup_preserves_distant_copies_and_opposite_strands(self):
        features = [{'name': 'copy', 'start': 0, 'end': 100},
                    {'name': ' COPY ', 'start': 100, 'end': 200},
                    {'name': 'copy', 'start': 600, 'end': 700},
                    {'name': 'copy', 'start': 0, 'end': 100, 'direction': '-'},
                    {'name': 'seam', 'start': 950, 'end': 1000},
                    {'name': 'seam', 'start': 0, 'end': 50}]
        data = _load_map({'sequence': 'ACGT' * 250}, features)
        self.assertEqual(len(data['features']), 4)
        self.assertEqual(next(f for f in data['features'] if f['name'] == 'seam')['spans'],
                         [(0, 50), (950, 1000)])

    def test_lengths_empty_annotations_highlights_and_adaptive_ticks(self):
        for length in (1, 19, 120, 2686, 6000, 100000):
            with self.subTest(length=length):
                _, _, audit = self.assert_geometry({'sequence': 'A' * length}, [])
                ticks, step = _tick_positions(length)
                self.assertGreater(step, 0)
                self.assertEqual(ticks[0], 0)
                self.assertLess(ticks[-1], length)
                self.assertEqual(audit['labels'], 0)
        args = {'sequence': 'ATGC' * 250, 'highlight_regions': [
            {'start': 950, 'end': 20, 'label': 'cross-origin highlight'}]}
        self.assert_geometry(args, [])

    def test_png_svg_and_stdin_contract(self):
        for fmt in ('png', 'svg'):
            path = Path(self.tmp.name) / f'map.{fmt}'
            request = {'op': 'plasmid_map', 'args': {'genbank_file': str(FIXTURE),
                       'name': 'pUC19', 'out_file': str(path), 'output_format': fmt}}
            process = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'python' / 'bio_ops.py')],
                                     input=json.dumps(request), text=True, capture_output=True, check=True)
            reply = json.loads(process.stdout)
            self.assertTrue(reply['ok'], reply)
            self.assertEqual(reply['result'], {'name': 'pUC19', 'graphic': True,
                             'out_file': str(path.resolve()), 'output_format': fmt, 'figure_width': 10.0})
            self.assertEqual(process.stderr, '')
            if fmt == 'png':
                self.assertTrue(path.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))
            else:
                root = ET.parse(path).getroot()
                ids = [element.attrib.get('id', '') for element in root.iter()]
                self.assertEqual(len([gid for gid in ids if gid.startswith('label:')]), 10)
                self.assertEqual(sum(gid == 'center:info' for gid in ids), 1)

    def test_no_circular_dependency_on_dna_features_viewer(self):
        original = importlib.import_module
        def guarded(name, *args, **kwargs):
            if name == 'dna_features_viewer':
                raise ImportError(name)
            return original(name, *args, **kwargs)
        # Clear importability for ordinary import statements, too.
        with patch.dict(sys.modules, {'dna_features_viewer': None}), patch('importlib.import_module', guarded):
            result = _plasmid_graphic({'sequence': 'ATGC' * 250,
                                      'out_file': os.path.join(self.tmp.name, 'no_dfv.png')},
                                     [{'name': 'gene', 'start': 0, 'end': 100}])
        self.assertTrue(result['graphic'], result)

    def test_linear_dispatch_and_text_golden(self):
        features = [{'name': 'a', 'start': 0, 'end': 100, 'type': 'cds'},
                    {'name': 'b', 'start': 50, 'end': 150, 'type': 'origin', 'direction': '-'}]
        with patch('plasmid_render.render_circular_map', side_effect=AssertionError('circular called')) as mock:
            result = _plasmid_graphic({'circular': False, 'sequence': 'ATGC' * 50,
                                      'out_file': os.path.join(self.tmp.name, 'linear.png')}, features)
            self.assertTrue(result['graphic'], result)
            mock.assert_not_called()
            text = op_plasmid_map({'name': 'text-test', 'size': 200, 'features': features})
            mock.assert_not_called()
        self.assertEqual(text['mode'], 'text')
        self.assertEqual(text['feature_bp'], 150)
        self.assertEqual(text['unannotated_bp'], 50)
        self.assertEqual(text['features'], features)
        self.assertIsNone(text['output_file'])
        self.assertIn('未注释区域: 50 bp (25.0%)', text['map_text'])
        self.assertIn('a (cds, 100bp)', text['map_text'])
        self.assertIn('b (origin, 100bp)', text['map_text'])

    def test_failure_falls_back_to_existing_text_contract(self):
        features = [{'name': 'bad', 'start': 0, 'end': 101}]
        for override in ({'sequence': 'A' * 100},
                         {'sequence': 'A' * 200, 'figure_width': 0},
                         {'genbank_file': os.path.join(self.tmp.name, 'missing.gb')},
                         {'sequence': 'A' * 200, 'out_file': os.path.join(self.tmp.name, 'missing', 'x.png')}):
            with self.subTest(override=override):
                result = op_plasmid_map({'name': 'fallback', 'features': features, **override})
                self.assertEqual(result['mode'], 'text', result)
                self.assertIsNone(result['output_file'])
                self.assertIn('图形渲染失败，已回退文本模式', result['graphic_note'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
