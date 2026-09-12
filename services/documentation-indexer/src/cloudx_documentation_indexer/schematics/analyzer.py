from __future__ import annotations

import json

from PIL import Image

from .detector import DetectorUnavailable, SchematicAnalysisSettings, SINA_ADAPTER_VERSION, SinaDetector
from .domain import Bounds, Capability, CircuitGraph, Component, Issue, SchematicPageAnalysis, SourceGeometry
from .geometry import cut_component_interiors, connect_terminals
from .native_pdf import assign_native_text, attach_native_inversion_contacts, attach_native_ports, image_bounds, native_pdf_geometry, rectangular_board_components
from .native_hierarchy import attach_native_hierarchy
from .ocr import LocalOcr, OcrUnavailable
from .raster import raster_wire_geometry


def overlapping_symbols(left: Component, right: Component) -> bool:
    a, b = left.bounds, right.bounds
    intersection = max(0, min(a.right, b.right) - max(a.left, b.left)) * max(0, min(a.bottom, b.bottom) - max(a.top, b.top))
    smaller = min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top))
    return smaller > 0 and intersection / smaller > 0.6


class SchematicAnalyzer:
    def __init__(self, settings: SchematicAnalysisSettings, detector=None):
        self.settings = settings
        self.detector = detector

    def analyze(self, image: Image.Image, source: SourceGeometry, circuit_id: str, page=None, *, native=None, region_renderer=None) -> SchematicPageAnalysis:
        capabilities, components = [], []
        if page is not None:
            try:
                if native is None:
                    native = native_pdf_geometry(page, source, circuit_id)
            except ValueError as error:
                return blocked_geometry(source, circuit_id, capabilities, "native-pdf", str(error))
            components.extend(native.board_components)
        ocr_words, ocr_capabilities = self.recognize_text(image, source, page, native, region_renderer)
        capabilities.extend(ocr_capabilities)
        if page is not None:
            if ocr_words:
                for component in rectangular_board_components(page, source, circuit_id, [*native.text, *ocr_words]):
                    existing = next((existing for existing in components if overlapping_symbols(component, existing)), None)
                    if existing is not None and existing.reference is None and component.reference is not None:
                        existing.reference, existing.kind = component.reference, component.kind
                        existing.evidence.extend(component.evidence)
                    elif existing is None:
                        component.id = f"{circuit_id}:ocr-body-{len(components) + 1}"
                        components.append(component)
            capabilities.append(Capability(name="native-pdf", state="supported", detail="Native vector paths and positioned text retained independently of detector availability.", version="cloudx-native-schematic/1"))
        if self.settings.model_path is not None:
            try:
                detector = self.detector if self.detector is not None else SinaDetector(self.settings)
                detections = detector.detect(image, circuit_id)
                for detection in detections:
                    overlap = next((component for component in components if overlapping_symbols(component, detection)), None)
                    if overlap:
                        overlap.evidence.extend(detection.evidence)
                    else:
                        components.append(detection)
                capabilities.append(Capability(name="sina-detector", state="supported", detail=f"Retained {len(detections)} local symbol candidates; detector labels do not establish pin or net correctness.", version=SINA_ADAPTER_VERSION, model_sha256=self.settings.model_sha256,
                    parameters=detector.execution_parameters))
            except DetectorUnavailable as error:
                capabilities.append(Capability(name="sina-detector", state="blocked", detail=str(error), version=SINA_ADAPTER_VERSION, model_sha256=self.settings.model_sha256))
        else:
            capabilities.append(Capability(name="sina-detector", state="blocked", detail="Local SINA model path and SHA-256 are not configured.", version=SINA_ADAPTER_VERSION))
        if native is not None:
            wires, junctions, words = native.wires, native.junctions, [*native.text, *ocr_words]
        else:
            try:
                raster = raster_wire_geometry(image, [word.bounds for word in ocr_words if word.evidence.confidence is not None and word.evidence.confidence >= 0.9])
            except ValueError as error:
                return blocked_geometry(source, circuit_id, capabilities, "raster-wire-geometry", str(error))
            wires, junctions, words = raster.wires, raster.junctions, ocr_words
            capabilities.append(Capability(name="raster-wire-geometry", state="unresolved", detail="Color-independent horizontal/vertical lines and pixel-supported corners retained; diagonal wires, text removal and ambiguous shapes require additional evidence.", version="cloudx-raster-wires/2"))
        if len(wires) > 30_000:
            return blocked_geometry(source, circuit_id, capabilities, "wire-connectivity", "Schematic analysis exceeds the wire segment limit")
        original_wires = wires
        geometry_components = []
        for component in components:
            native_symbol = any(evidence.kind == "native-vector" for evidence in component.evidence)
            if native is not None and not native_symbol:
                component.state = "unresolved"
            else:
                geometry_components.append(component)
        wires, terminals = cut_component_interiors(wires, geometry_components)
        if native is not None:
            attach_native_inversion_contacts(page, source, geometry_components, terminals, wires)
        scale = source.image_width / (source.page_bounds.right - source.page_bounds.left)
        assign_native_text(components, terminals, words, scale, original_wires)
        try:
            graph = connect_terminals(circuit_id, source.sheet_id, components, terminals, wires, junctions)
        except ValueError as error:
            return blocked_geometry(source, circuit_id, capabilities, "wire-connectivity", str(error))
        graph.text = words
        if words:
            attach_native_ports(graph, scale)
        if native is not None:
            attach_native_hierarchy(page, source, graph)
        graph.issues.append(Issue(code="electrical-review-required", detail="Component and wire candidates require verified pin identities, net scope and source values before authoritative circuit export."))
        for component in components:
            contacts = [terminal for terminal in terminals if terminal.component_id == component.id]
            expected = {"Resistor": 2, "Capacitor": 2, "Inductor": 2, "Diode": 2, "GND": 1}.get(component.kind)
            if not contacts or expected is not None and len(contacts) != expected:
                graph.issues.append(Issue(code="terminal-count-unresolved", detail=f"Observed {len(contacts)} contacts for {component.kind}; component retained for review.", entity_ids=[component.id]))
        capabilities.append(Capability(name="electrical-netlist", state="unresolved", detail="Typed terminal/net incidence is available; no placeholder SPICE or inferred device models were produced.", version="cloudx-terminal-graph/1"))
        return SchematicPageAnalysis(source=source, capabilities=capabilities, circuits=[graph])


    def recognize_text(self, image, source, page, native, region_renderer):
        settings = self.settings
        parameters = {"mode": settings.ocr_mode}
        if settings.ocr is None:
            return [], [Capability(name="local-ocr", state="blocked", parameters=parameters,
                detail="Local OCR executable and model assets are not configured; outlined and raster text remains unresolved.")]
        batches = []
        if page is None or settings.ocr_mode == 'full-page':
            batches.append(('local-ocr', None))
        elif page.images:
            regions = []
            for obj in page.images:
                bounds = image_bounds(source, obj)
                left, top = max(0, bounds.left), max(0, bounds.top)
                right, bottom = min(image.width, bounds.right), min(image.height, bounds.bottom)
                if left < right and top < bottom:
                    regions.append(Bounds(left=left, top=top, right=right, bottom=bottom))
            if regions:
                batches.append(('local-image-ocr', regions))
        if native is not None:
            bodies = [body for body in native.board_components if body.kind in {'Rectangle', 'IntegratedCircuit', 'Connector'}
                      and (settings.ocr_mode == 'full-page' or body.reference is None)]
            scale = source.image_width / (source.page_bounds.right - source.page_bounds.left)
            headers = [Bounds(left=max(0, body.bounds.left - 2 * scale), top=max(0, body.bounds.top - 18 * scale),
                       right=min(image.width, body.bounds.right), bottom=body.bounds.top) for body in bodies if body.bounds.top > 0]
            if headers:
                batches.append(('local-body-label-ocr', headers))
        if not batches:
            return [], [Capability(name="local-ocr", state="unsupported", parameters=parameters,
                detail="Selected native-text policy found no embedded images or unidentified body headers requiring OCR; other outlined text is not covered by this policy.")]
        words, capabilities = [], []
        ocr = LocalOcr(settings.ocr)
        for name, regions in batches:
            try:
                if name == 'local-image-ocr' and region_renderer is not None:
                    result = ocr.recognize_regions(image, regions, render_region=region_renderer.render)
                else:
                    result = ocr.recognize(image) if regions is None else ocr.recognize_regions(image, regions)
                for word in result.words:
                    word.id = f'{name}:{word.id}'
                    word.evidence.locator = f'{name}:{word.evidence.locator}'
                    if name == 'local-image-ocr':
                        word.assignment_eligible = False
                words.extend(result.words)
                capabilities.append(Capability(name=name, state="supported", version=result.engine_version,
                    model_sha256=result.model_sha256, detail=f"Retained {len(result.words)} positioned OCR observations; recognized text requires source review.",
                    parameters={**parameters, "language": result.language, "executableSha256": result.executable_sha256,
                        "pageSegmentationMode": 11, "engineMode": 1, "imageScale": result.image_scale,
                        "regions": 1 if regions is None else len(regions),
                        "pdfRenderScale": region_renderer.scale if name == 'local-image-ocr' and region_renderer is not None else 0,
                        "sourceRegionsJson": json.dumps([] if regions is None else [region.model_dump(mode='json', by_alias=True) for region in regions])}))
            except OcrUnavailable as error:
                capabilities.append(Capability(name=name, state="blocked", detail=str(error), parameters=parameters))
        return words, capabilities


def blocked_geometry(source: SourceGeometry, circuit_id: str, capabilities: list[Capability], name: str, detail: str) -> SchematicPageAnalysis:
    capabilities.append(Capability(name=name, state="blocked", detail=detail))
    capabilities.append(Capability(name="electrical-netlist", state="blocked", detail="Geometric analysis did not complete; source text extraction remains independent."))
    graph = CircuitGraph(id=circuit_id, sheet_id=source.sheet_id, state="blocked", issues=[Issue(code="geometry-limit", detail=detail)])
    return SchematicPageAnalysis(source=source, capabilities=capabilities, circuits=[graph])
