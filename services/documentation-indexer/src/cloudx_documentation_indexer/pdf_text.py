"""Retain PDF paint semantics and keep overlapping text layers separate."""

from collections import defaultdict
from operator import itemgetter

from pdfminer.layout import LTChar
from pdfminer.pdfinterp import PDFPageInterpreter
from pdfplumber.page import FilteredPage, Page, PDFPageAggregatorWithMarkedContent
from pdfplumber.utils import cluster_objects
from pdfplumber.utils.exceptions import PdfminerException


class TextPaintAggregator(PDFPageAggregatorWithMarkedContent):
    rendering_mode = 0

    def render_string(self, textstate, *args):
        previous = self.rendering_mode
        self.rendering_mode = textstate.render
        try:
            return super().render_string(textstate, *args)
        finally:
            self.rendering_mode = previous

    def render_char(self, *args, **kwargs):
        advance = super().render_char(*args, **kwargs)
        self.cur_item._objs[-1].rendering_mode = self.rendering_mode
        return advance


class SourcePdfPage(Page):
    def __init__(self, page: Page):
        super().__init__(page.pdf, page.page_obj, page.page_number, page.initial_doctop)

    @property
    def layout(self):
        if not hasattr(self, '_layout'):
            device = TextPaintAggregator(self.pdf.rsrcmgr, pageno=self.page_number, laparams=self.pdf.laparams)
            try:
                PDFPageInterpreter(self.pdf.rsrcmgr, device).process_page(self.page_obj)
            except Exception as error:
                raise PdfminerException(error) from error
            self._layout = device.get_result()
        return self._layout

    def process_object(self, obj):
        result = super().process_object(obj)
        if isinstance(obj, LTChar):
            result['rendering_mode'] = obj.rendering_mode
        return result


def is_painted_text(item: dict) -> bool:
    return item.get('rendering_mode', 0) not in {3, 7}


def deduplicated_chars(chars: list[dict], tolerance: float = 1) -> list[dict]:
    groups = defaultdict(list)
    positions = {}
    for position, char in enumerate(chars):
        positions.setdefault(id(char), position)
        paint = tuple(tuple(value) if isinstance(value, list) else value
                      for value in (char.get('non_stroking_color'), char.get('stroking_color')))
        key = (char['upright'], char['text'], char.get('fontname'), char.get('size'), char.get('rendering_mode', 0), paint)
        groups[key].append(char)
    unique = []
    for group in groups.values():
        for row in cluster_objects(group, itemgetter('doctop'), tolerance):
            for column in cluster_objects(row, itemgetter('x0'), tolerance):
                unique.append(min(column, key=itemgetter('doctop', 'x0')))
    return sorted(unique, key=lambda char: positions[id(char)])


def deduplicated_page(page):
    result = FilteredPage(page, lambda _: True)
    result._objects = {**page.objects, 'char': deduplicated_chars(page.chars)}
    return result


def positioned_words(page):
    return deduplicated_page(page).extract_words(x_tolerance=1, y_tolerance=2,
        extra_attrs=['non_stroking_color', 'stroking_color'])


def is_light_text(item: dict) -> bool:
    if item.get("object_type") != "char":
        return False
    color = item.get("non_stroking_color")
    if isinstance(color, (int, float)):
        return color >= .9
    if isinstance(color, (list, tuple)) and len(color) in {1, 3}:
        return min(color) >= .9
    if isinstance(color, (list, tuple)) and len(color) == 4:
        return max(color) <= .1
    return False


def separated_text_pages(page):
    layers = [("", lambda char: is_painted_text(char) and not is_light_text(char)),
              (" light-colored text layer", lambda char: is_painted_text(char) and is_light_text(char)),
              (" nonpainting text layer", lambda char: not is_painted_text(char))]
    return [(name, deduplicated_page(page.filter(lambda item, selected=selected: item.get('object_type') != 'char' or selected(item))))
            for name, selected in layers if not name or any(selected(char) for char in page.chars)]
