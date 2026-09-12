"""Passive Altium PDF declarations, kept separate from observed circuit geometry."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Literal

from pdfminer.pdfexceptions import PDFException
from pdfminer.pdftypes import PDFObjRef, PDFStream
from pdfminer.psparser import PSLiteral
from pdfminer.utils import decode_text
from pydantic import Field

from .domain import AnalysisState, Issue, SchematicModel


@dataclass(frozen=True)
class PdfMetadataLimits:
    max_objects: int = 200_000
    max_depth: int = 32
    max_script_bytes: int = 128_000
    max_total_script_bytes: int = 8_000_000
    max_string_bytes: int = 8192
    max_properties: int = 256

    def __post_init__(self):
        if any(value <= 0 for value in vars(self).values()):
            raise ValueError('PDF metadata limits must be positive')


class PdfDeclarationEvidence(SchematicModel):
    kind: Literal['declared'] = 'declared'
    outline_object: int | None = None
    action_objects: list[int] = Field(default_factory=list)


class PdfDeclaredComponent(SchematicModel):
    page_number: int = Field(ge=1)
    scope: tuple[str, ...]
    reference: str
    token: str
    evidence: PdfDeclarationEvidence


class PdfDeclaredPin(SchematicModel):
    page_number: int = Field(ge=1)
    scope: tuple[str, ...]
    component_reference: str
    pin: str
    token: str
    evidence: PdfDeclarationEvidence


class PdfDeclaredNet(SchematicModel):
    page_number: int = Field(ge=1)
    scope: tuple[str, ...]
    name: str
    pin_tokens: list[str]
    evidence: list[PdfDeclarationEvidence]


class PdfComponentProperty(SchematicModel):
    name: str
    value: str


class PdfComponentMenu(SchematicModel):
    page_number: int = Field(ge=1)
    annotation_object: int | None
    action_object: int | None
    script_object: int | None
    menu_name: str
    script_sha256: str
    annotation_rect_pdf: tuple[float, float, float, float]
    properties: list[PdfComponentProperty]
    evidence_kind: Literal['declared'] = 'declared'
    coordinate_system: Literal['pdf-user-space'] = 'pdf-user-space'


class PdfPageMetadataCoverage(SchematicModel):
    page_number: int = Field(ge=1)
    page_object: int
    outline_components: int = 0
    declared_pins: int = 0
    component_menus: int = 0
    state: AnalysisState = 'unsupported'


class PdfDeclaredMetadata(SchematicModel):
    schema_version: Literal[1] = 1
    profile: Literal['altium-smart-pdf-literal/1'] = 'altium-smart-pdf-literal/1'
    source_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    state: AnalysisState = 'unsupported'
    issues: list[Issue] = Field(default_factory=list)
    pages: list[PdfPageMetadataCoverage] = Field(default_factory=list)
    components: list[PdfDeclaredComponent] = Field(default_factory=list)
    pins: list[PdfDeclaredPin] = Field(default_factory=list)
    nets: list[PdfDeclaredNet] = Field(default_factory=list)
    component_menus: list[PdfComponentMenu] = Field(default_factory=list)


class MetadataError(ValueError):
    state: AnalysisState = 'failed'


class MetadataBudgetExceeded(MetadataError):
    state: AnalysisState = 'blocked'


class UnsupportedMetadata(MetadataError):
    state: AnalysisState = 'unsupported'


def _object_id(value):
    return value.objid if isinstance(value, PDFObjRef) else None


def _name(value):
    return value.name if isinstance(value, PSLiteral) else None


class PdfMetadataReader:
    """One document's bounded dictionary traversal; never runs action payloads."""

    def __init__(self, pdf, limits: PdfMetadataLimits):
        self.pdf = pdf
        self.limits = limits
        self.objects = 0
        self.script_bytes = 0
        self.pages = {page.page_obj.pageid: page.page_number for page in pdf.pages}

    def resolve(self, value):
        seen = set()
        while isinstance(value, PDFObjRef):
            if value.objid in seen:
                raise MetadataError('Cyclic indirect PDF metadata reference')
            seen.add(value.objid)
            self.visit(len(seen))
            value = value.resolve()
        return value

    def visit(self, depth=0):
        self.objects += 1
        if depth > self.limits.max_depth or self.objects > self.limits.max_objects:
            raise MetadataBudgetExceeded('PDF metadata object/depth budget exceeded')

    def mapping(self, value):
        value = self.resolve(value)
        if not isinstance(value, dict):
            raise MetadataError('PDF metadata dictionary required')
        return value

    def sequence(self, value):
        value = self.resolve(value)
        if not isinstance(value, list):
            raise MetadataError('PDF metadata array required')
        if len(value) > self.limits.max_objects:
            raise MetadataBudgetExceeded('PDF metadata array budget exceeded')
        return value

    def text(self, value):
        value = self.resolve(value)
        if not isinstance(value, bytes):
            raise MetadataError('PDF metadata string required')
        if len(value) > self.limits.max_string_bytes:
            raise MetadataBudgetExceeded('PDF metadata string budget exceeded')
        return decode_text(value)

    def script(self, action):
        value = self.resolve(action.get('JS'))
        if isinstance(value, PDFStream):
            raise UnsupportedMetadata('This metadata profile requires literal JavaScript strings; streams are not decompressed')
        if not isinstance(value, bytes):
            raise MetadataError('PDF JavaScript literal string required')
        self.script_bytes += len(value)
        if len(value) > self.limits.max_script_bytes or self.script_bytes > self.limits.max_total_script_bytes:
            raise MetadataBudgetExceeded('PDF metadata script budget exceeded')
        return decode_text(value)

    def names(self, value, seen=None, depth=0):
        seen = set() if seen is None else seen
        identity = _object_id(value) or id(value)
        if identity in seen:
            raise MetadataError('Cyclic PDF metadata name tree')
        seen.add(identity)
        self.visit(depth)
        node = self.mapping(value)
        pairs = self.sequence(node.get('Names', []))
        if len(pairs) % 2:
            raise MetadataError('PDF metadata name tree has an unpaired entry')
        for index in range(0, len(pairs), 2):
            yield self.text(pairs[index]), pairs[index+1]
        for child in self.sequence(node.get('Kids', [])):
            yield from self.names(child, seen, depth+1)

    def property_menus(self):
        names = self.mapping(self.pdf.doc.catalog.get('Names', {}))
        menus = {}
        if 'JavaScript' not in names:
            return menus
        for name, reference in self.names(names['JavaScript']):
            if name in ('_FindWord', '_HighlightRect'):
                continue
            if not re.fullmatch(r'ShowCompProps_[A-Fa-f0-9]{32}', name):
                continue
            if name in menus:
                raise MetadataError('Duplicate component property menu name')
            action = self.mapping(reference)
            if _name(action.get('S')) != 'JavaScript':
                raise MetadataError('Component property menu must be a JavaScript literal action')
            script = self.script(action)
            properties = self.literal_properties(name, script)
            menus[name] = (reference, script, properties)
        return menus

    def literal_properties(self, name, script):
        prefix = re.match(r'function\s+'+re.escape(name)+r'\s*\(\)\s*\{\s*var\s+sChoice\s*=\s*app\.popUpMenu\(', script)
        if not prefix:
            raise MetadataError('Unrecognized component property menu function')
        position = prefix.end()
        decoder = json.JSONDecoder()
        properties = []
        while True:
            position = _skip_space(script, position)
            if script[position:position+1] != '"':
                raise MetadataError('Component property menu requires literal string arguments')
            try:
                value, end = decoder.raw_decode(script, position)
            except ValueError as error:
                raise MetadataError('Component property menu requires literal string arguments') from error
            if not isinstance(value, str) or ': ' not in value:
                raise MetadataError('Component property must be a literal name: value string')
            try:
                encoded = value.encode()
            except UnicodeError as error:
                raise MetadataError('Invalid Unicode in component property') from error
            if len(encoded) > self.limits.max_string_bytes or len(properties) >= self.limits.max_properties:
                raise MetadataBudgetExceeded('Component property budget exceeded')
            key, text = value.split(': ', 1)
            properties.append(PdfComponentProperty(name=key, value=text))
            position = _skip_space(script, end)
            if script[position:position+1] == ')':
                if not script[position+1:].lstrip().startswith(';'):
                    raise MetadataError('Malformed component property menu terminator')
                return properties
            if script[position:position+1] != ',':
                raise MetadataError('Component property menu requires literal string arguments')
            position += 1

    def action_chain(self, value, seen=None, depth=0):
        if value is None:
            return []
        seen = set() if seen is None else seen
        self.visit(depth)
        identity = _object_id(value) or id(value)
        if identity in seen:
            raise MetadataError('Cyclic PDF metadata action chain')
        seen.add(identity)
        resolved = self.resolve(value)
        if isinstance(resolved, list):
            return [entry for child in self.sequence(resolved) for entry in self.action_chain(child, seen, depth+1)]
        action = self.mapping(resolved)
        return [(value, action), *self.action_chain(action.get('Next'), seen, depth+1)]

    def target(self, node):
        chain = self.action_chain(node.get('A'))
        page_number = None
        token = None
        for _, action in chain:
            kind = _name(action.get('S'))
            if kind == 'GoTo':
                destination = self.sequence(action.get('D'))
                if len(destination) < 2 or _object_id(destination[0]) not in self.pages:
                    raise MetadataError('PDF metadata destination requires an existing physical page')
                if page_number is not None:
                    raise MetadataError('Ambiguous PDF metadata destination')
                page_number = self.pages[_object_id(destination[0])]
            elif kind == 'JavaScript':
                match = re.fullmatch(r'_FindWord\(([0-9]{1,9}), "([A-Za-z0-9_]+)"\);', self.script(action))
                if not match:
                    raise UnsupportedMetadata('Unrecognized PDF outline highlighting action')
                if page_number != int(match[1])+1 or token is not None:
                    raise MetadataError('PDF metadata destination and FindWord page disagree or are ambiguous')
                token = match[2]
            else:
                raise UnsupportedMetadata('Unrecognized PDF outline action type')
        return page_number, token, [number for ref, _ in chain if (number := _object_id(ref)) is not None]

    def outlines(self, value, path=(), seen=None):
        seen = set() if seen is None else seen
        while value is not None:
            self.visit(len(path))
            identity = _object_id(value) or id(value)
            if identity in seen:
                raise MetadataError('Cyclic PDF metadata outline')
            seen.add(identity)
            node = self.mapping(value)
            title = self.text(node.get('Title'))
            current = (*path, title)
            page, token, action_objects = self.target(node)
            yield current, page, token, PdfDeclarationEvidence(outline_object=_object_id(value), action_objects=action_objects)
            if node.get('First') is not None:
                yield from self.outlines(node['First'], current, seen)
            value = node.get('Next')

    def declarations(self, result):
        root = self.mapping(self.pdf.doc.catalog.get('Outlines', {}))
        memberships = []
        for path, page, token, evidence in self.outlines(root.get('First')):
            if len(path) >= 2 and path[-2] == 'Components':
                self.require_target(page, token)
                result.components.append(PdfDeclaredComponent(page_number=page, scope=path[:-2], reference=path[-1], token=token, evidence=evidence))
            elif len(path) >= 3 and path[-3] == 'Components':
                self.require_target(page, token)
                result.pins.append(PdfDeclaredPin(page_number=page, scope=path[:-3], component_reference=path[-2], pin=path[-1], token=token, evidence=evidence))
            elif len(path) >= 4 and path[-4] == 'Nets' and path[-2] == 'Pins':
                self.require_target(page, token)
                memberships.append((path[:-4], path[-3], path[-1], page, token, evidence))
        self.assign_nets(result, memberships)

    @staticmethod
    def require_target(page, token):
        if page is None or not token:
            raise MetadataError('Declared component or pin lacks a physical-page/token target')

    @staticmethod
    def assign_nets(result, memberships):
        pins = {}
        for pin in result.pins:
            key = (pin.page_number, pin.token)
            if key in pins:
                raise MetadataError('Duplicate or ambiguous physical pin token')
            pins[key] = pin
        components = set()
        references = set()
        for component in result.components:
            key = (component.page_number, component.token)
            reference = (component.page_number, component.reference)
            if key in components or reference in references:
                raise MetadataError('Duplicate or ambiguous physical component identity')
            components.add(key)
            references.add(reference)
        assigned = set()
        nets = {}
        for scope, name, pin_name, page, token, evidence in memberships:
            key = (page, token)
            pin = pins.get(key)
            if pin is None or pin.pin != pin_name or pin.scope != scope:
                raise MetadataError('Net membership does not match a declared pin and sheet scope')
            if key in assigned:
                raise MetadataError('A physical pin has multiple declared net memberships')
            assigned.add(key)
            net_key = (page, scope, name)
            net = nets.setdefault(net_key, PdfDeclaredNet(page_number=page, scope=scope, name=name, pin_tokens=[], evidence=[]))
            net.pin_tokens.append(token)
            net.evidence.append(evidence)
        result.nets = list(nets.values())
        if set(pins) != assigned:
            result.issues.append(Issue(code='incomplete-net-membership', detail='Some declared pins have no exported net membership'))

    def attach_menus(self, result, menus):
        for page in self.pdf.pages:
            for reference in self.sequence(page.page_obj.annots or []):
                self.visit()
                annotation = self.mapping(reference)
                if _name(annotation.get('Subtype')) != 'Link':
                    continue
                chain = self.action_chain(annotation.get('A'))
                for action_ref, action in chain:
                    if _name(action.get('S')) != 'JavaScript':
                        continue
                    match = re.fullmatch(r'(ShowCompProps_[A-Fa-f0-9]{32})\(\);', self.script(action))
                    if not match:
                        raise UnsupportedMetadata('Unrecognized component annotation action')
                    if match[1] not in menus:
                        raise MetadataError('Component annotation refers to a missing property menu')
                    script_ref, script, properties = menus[match[1]]
                    rect = self.sequence(annotation.get('Rect'))
                    if len(rect) != 4 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in rect):
                        raise MetadataError('Invalid component annotation rectangle')
                    result.component_menus.append(PdfComponentMenu(page_number=page.page_number, annotation_object=_object_id(reference), action_object=_object_id(action_ref), script_object=_object_id(script_ref), menu_name=match[1], script_sha256=hashlib.sha256(script.encode()).hexdigest(), annotation_rect_pdf=tuple(rect), properties=properties))

    def coverage(self, result):
        for page_object, page_number in self.pages.items():
            coverage = PdfPageMetadataCoverage(page_number=page_number, page_object=page_object,
                outline_components=sum(c.page_number == page_number for c in result.components),
                declared_pins=sum(p.page_number == page_number for p in result.pins),
                component_menus=sum(m.page_number == page_number for m in result.component_menus))
            if coverage.outline_components:
                coverage.state = 'supported'
            if coverage.component_menus != coverage.outline_components:
                coverage.state = 'unresolved'
                result.issues.append(Issue(code='incomplete-page-metadata', detail=f'Page {page_number} has {coverage.outline_components} component identities and {coverage.component_menus} property menus; coverage is incomplete'))
            result.pages.append(coverage)


def _skip_space(text, position):
    while position < len(text) and text[position].isspace():
        position += 1
    return position


def extract_pdf_metadata(pdf, source_sha256: str, *, limits: PdfMetadataLimits | None = None) -> PdfDeclaredMetadata:
    """Read declared metadata from an already-open pdfplumber document.

    Supported means this grammar yielded declarations, not that a circuit is
    electrically correct or that the PDF includes every original design fact.
    """
    result = PdfDeclaredMetadata(source_sha256=source_sha256)
    try:
        reader = PdfMetadataReader(pdf, limits or PdfMetadataLimits())
        menus = reader.property_menus()
        if not menus:
            raise UnsupportedMetadata('No recognized Altium literal component metadata is available')
        reader.declarations(result)
        reader.attach_menus(result, menus)
        reader.coverage(result)
        if not result.components and not result.component_menus:
            raise UnsupportedMetadata('No recognized Altium component declarations are available')
        result.state = 'unresolved' if result.issues else 'supported'
        return result
    except (MetadataError, PDFException) as error:
        return PdfDeclaredMetadata(source_sha256=source_sha256, state=error.state if isinstance(error, MetadataError) else 'failed',
            issues=[Issue(code='pdf-declared-metadata-unavailable', detail=str(error))])
