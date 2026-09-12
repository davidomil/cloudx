"""Render bounded PDF regions directly, preserving detail lost in page previews."""
import math

from .domain import Bounds
from .ocr import OcrUnavailable


def rendered_page_bounds(page, pdf, page_number):
    """Express PDFium's visible box in pdfplumber's rotated top-left coordinates."""
    rendered = pdf[page_number - 1]
    try:
        left, bottom, right, top = rendered.get_bbox()
    finally:
        rendered.close()
    x0, y0, x1, y1 = page.page_obj.mediabox
    if page.rotation == 90:
        box = (bottom - y0, left - x0, top - y0, right - x0)
    elif page.rotation == 180:
        box = (x1 - right, bottom - y0, x1 - left, top - y0)
    elif page.rotation == 270:
        box = (y1 - top, x1 - right, y1 - bottom, x1 - left)
    else:
        box = (left - x0, y1 - top, right - x0, y1 - bottom)
    offset_x, offset_y = page.mediabox[:2]
    return Bounds(left=box[0] + offset_x, top=box[1] + offset_y,
                  right=box[2] + offset_x, bottom=box[3] + offset_y)


class PdfRegionRenderer:
    scale = 4

    def __init__(self, pdf, page_number, image_width, image_height):
        self.pdf = pdf
        self.page_number = page_number
        self.image_width = image_width
        self.image_height = image_height

    def render(self, region):
        if not (0 <= region.left < region.right <= self.image_width and 0 <= region.top < region.bottom <= self.image_height):
            raise OcrUnavailable('PDF OCR region exceeds its source image')
        page = self.pdf[self.page_number - 1]
        try:
            width, height = page.get_size()
            crop = (region.left * width / self.image_width, (self.image_height - region.bottom) * height / self.image_height,
                    (self.image_width - region.right) * width / self.image_width, region.top * height / self.image_height)
            left, bottom, right, top = [math.ceil(value * self.scale) for value in crop]
            pixels = (math.ceil(width * self.scale) - left - right) * (math.ceil(height * self.scale) - bottom - top)
            if pixels <= 0 or pixels > 25_000_000:
                raise OcrUnavailable('PDF OCR region exceeds its render pixel limit')
            bitmap = page.render(scale=self.scale, crop=crop)
            try:
                return bitmap.to_pil().copy()
            finally:
                bitmap.close()
        finally:
            page.close()
