"""Whole-source coverage and source-window identity survive optional tiling."""
from types import SimpleNamespace

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics.worker import image_regions, merge_detections, predict_regions
from cloudx_documentation_indexer.schematics import worker


def candidate(kind, bounds, confidence, window):
    return {'kind': kind, 'bounds': dict(zip(('left', 'top', 'right', 'bottom'), bounds)),
            'confidence': confidence, 'sourceWindow': dict(zip(('left', 'top', 'right', 'bottom'), window))}


@pytest.mark.parametrize('width,height', [(1584, 1224), (4894, 3168), (1536, 1536), (20, 10), (3100, 1)])
def test_regions_cover_every_source_pixel_with_bounded_overlap(width, height):
    regions = image_regions(width, height, 1536)
    assert regions[0][:2] == (0, 0)
    assert max(r[2] for r in regions) == width and max(r[3] for r in regions) == height
    for y in sorted({r[1] for r in regions}):
        row = [r for r in regions if r[1] == y]
        assert row[0][0] == 0 and row[-1][2] == width
        assert all(right[0] <= left[2]-256 for left, right in zip(row, row[1:]))
    for x in sorted({r[0] for r in regions}):
        column = [r for r in regions if r[0] == x]
        assert column[0][1] == 0 and column[-1][3] == height
        assert all(bottom[1] <= top[3]-256 for top, bottom in zip(column, column[1:]))
    assert all(0 < r-l <= 1536 and 0 < b-t <= 1536 for l,t,r,b in regions)


def test_default_is_one_unchanged_whole_source_region():
    assert image_regions(4894, 3168, 0) == [(0, 0, 4894, 3168)]


def test_long_thin_source_cannot_allocate_unbounded_regions():
    with pytest.raises(ValueError, match='region count'):
        image_regions(25_000_000, 1, 1536)


def test_duplicate_removal_keeps_exact_best_box_and_distinct_neighbor_or_class():
    best = candidate('Capacitor', (1290, 20, 1320, 35), .9, (0, 0, 1536, 1536))
    duplicate = candidate('Capacitor', (1291, 20, 1321, 35), .7, (1280, 0, 2816, 1536))
    neighbor = candidate('Capacitor', (1340, 20, 1370, 35), .8, (1280, 0, 2816, 1536))
    other_class = candidate('Resistor', (1290, 20, 1320, 35), .6, (0, 0, 1536, 1536))
    assert merge_detections([duplicate, best, neighbor, other_class]) == [best, neighbor, other_class]


def test_excess_unique_components_fail_without_truncating_the_source():
    detections = [candidate('Resistor', (i*20, 0, i*20+10, 10), .9, (0, 0, 12000, 20)) for i in range(513)]
    with pytest.raises(ValueError, match='merged detection limit'):
        merge_detections(detections)


def test_candidate_work_is_bounded_before_quadratic_duplicate_comparison(monkeypatch):
    detections = [candidate('Resistor', (0, 0, 10, 10), .9, (0, 0, 20, 20))] * 4097
    monkeypatch.setattr(worker, 'bounds_overlap', lambda *args: pytest.fail('Comparison must not begin'))
    with pytest.raises(ValueError, match='unmerged detection limit'):
        merge_detections(detections)


def test_each_region_uses_original_pixels_and_predictions_return_to_page_coordinates():
    seen = []
    class Model:
        def predict(self, source, **kwargs):
            seen.append((source.size, source.getpixel((0, 0)), kwargs))
            box = SimpleNamespace(xyxy=[SimpleNamespace(tolist=lambda: [10., 2., 20., 8.])],
                                  cls=SimpleNamespace(item=lambda: 0), conf=SimpleNamespace(item=lambda: .8))
            return [SimpleNamespace(boxes=[box], names={0: 'Resistor'})]
    with Image.new('RGB', (3000, 10), 'white') as image:
        image.putpixel((1464, 0), (20, 30, 40))
        regions = image_regions(*image.size, 1536)
        detections = predict_regions(Model(), image, regions, 960, device='cpu')
    assert [x[0] for x in seen] == [(1536, 10), (1536, 10), (1536, 10)]
    assert seen[-1][1] == (20, 30, 40)
    assert all(call[2]['imgsz'] == 960 and call[2]['conf'] == .25 and call[2]['max_det'] == 512 for call in seen)
    assert detections[-1]['bounds'] == dict(left=1474., top=2., right=1484., bottom=8.)
    assert detections[-1]['sourceWindow'] == dict(left=1464, top=0, right=3000, bottom=10)
