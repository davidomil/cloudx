from __future__ import annotations

from collections import defaultdict
from typing import Literal
from pydantic import Field

from .domain import AnalysisState, Capability, SchematicModel, SchematicPageAnalysis
from .geometry import DisjointSets


class PortReference(SchematicModel):
    source_sha256: str
    sheet_id: str
    circuit_id: str
    port_id: str

    def key(self) -> tuple[str, str, str, str]:
        return self.source_sha256, self.sheet_id, self.circuit_id, self.port_id


class HierarchyBinding(SchematicModel):
    parent: PortReference
    child: PortReference


class NetReference(SchematicModel):
    source_sha256: str
    sheet_id: str
    circuit_id: str
    net_id: str


class DocumentNet(SchematicModel):
    id: str
    members: list[NetReference]


def resolve_document_ports(pages: list[SchematicPageAnalysis], bindings: list[HierarchyBinding]) -> list[DocumentNet]:
    references, ports = [], {}
    seen_references = set()
    groups = defaultdict(list)
    for page in pages:
        for circuit in page.circuits:
            net_indices = {}
            for net in circuit.nets:
                reference = NetReference(source_sha256=page.source.source_sha256, sheet_id=circuit.sheet_id, circuit_id=circuit.id, net_id=net.id)
                key = (reference.source_sha256, reference.sheet_id, reference.circuit_id, reference.net_id)
                if key in seen_references:
                    raise ValueError("Document contains duplicate circuit/net scope")
                if len(seen_references) >= 100_000:
                    raise ValueError("Document exceeds the 100000 scoped-net limit")
                seen_references.add(key)
                net_indices[net.id] = len(references)
                references.append(reference)
            for port in circuit.ports:
                key = (page.source.source_sha256, circuit.sheet_id, circuit.id, port.id)
                ports[key] = (port, circuit, net_indices[port.net_id])
                if port.state != "supported" or port.scope not in {"local", "global"}:
                    continue
                if not any(item.kind == "declared" for item in port.evidence):
                    raise ValueError("Resolved port scope requires explicit declaration evidence")
                if port.scope == "global":
                    if not circuit.design_id:
                        raise ValueError("Global ports require an explicit electrical design scope")
                    group = ("global", circuit.design_id, port.name)
                else:
                    group = ("local", page.source.source_sha256, circuit.sheet_id, circuit.id, tuple(port.hierarchy_path), port.name)
                groups[group].append(net_indices[port.net_id])
    sets = DisjointSets(len(references))
    for indices in groups.values():
        for index in indices[1:]:
            sets.join(indices[0], index)
    for binding in bindings:
        if binding.parent.key() not in ports or binding.child.key() not in ports:
            raise ValueError("Hierarchical binding refers to an unknown port")
        parent, parent_circuit, parent_index = ports[binding.parent.key()]
        child, child_circuit, child_index = ports[binding.child.key()]
        if any(port.scope != "hierarchical" or port.state != "supported" or not any(e.kind == "declared" for e in port.evidence) for port in (parent, child)):
            raise ValueError("Hierarchical binding requires declared supported hierarchical ports")
        if not parent_circuit.design_id or parent_circuit.design_id != child_circuit.design_id:
            raise ValueError("Hierarchical binding must stay within its electrical design")
        if parent.name != child.name or not parent.hierarchy_path or child.hierarchy_path[:-1] != parent.hierarchy_path:
            raise ValueError("Hierarchical binding must match its named parent/child instance path")
        sets.join(parent_index, child_index)
    nets = defaultdict(list)
    for index, reference in enumerate(references):
        nets[sets.find(index)].append(reference)
    return [DocumentNet(id=f"document-net-{index + 1}", members=members) for index, members in enumerate(nets.values())]


class DocumentPortAnalysis(SchematicModel):
    schema_version: Literal[2] = 2
    state: AnalysisState = 'unresolved'
    bindings: list[HierarchyBinding]
    nets: list[DocumentNet]
    issues: list[str]
    capabilities: list[Capability] = Field(default_factory=list)


def resolve_native_document_ports(pages: list[SchematicPageAnalysis]) -> DocumentPortAnalysis:
    if len(pages) > 200:
        raise ValueError('Schematic document exceeds the 200-page scope limit')
    pages = [page.model_copy(deep=True) for page in pages]
    targets, parent_instances = defaultdict(list), defaultdict(set)
    for page in pages:
        for circuit in page.circuits:
            if circuit.sheet_name:
                targets[(page.source.source_sha256, circuit.sheet_name)].append((page, circuit))
            for port in circuit.ports:
                if port.scope == 'hierarchical' and port.target_sheet:
                    parent_instances[(page.source.source_sha256, port.target_sheet)].add((page.source.sheet_id, circuit.id, port.instance_id))
    bindings, issues = [], []
    for page in pages:
        for circuit in page.circuits:
            for port in circuit.ports:
                if port.scope != 'hierarchical' or not port.target_sheet or port.state != 'supported':
                    continue
                key = (page.source.source_sha256, port.target_sheet)
                candidates = targets.get(key, [])
                if len(candidates) != 1 or len(parent_instances[key]) != 1:
                    issues.append(f'Port {port.name}: target sheet {port.target_sheet} is missing, repeated or has multiple unresolved instances')
                    continue
                child_page, child_circuit = candidates[0]
                child_ports = [item for item in child_circuit.ports if item.scope == 'hierarchical' and item.state == 'supported' and item.target_sheet is None and item.name == port.name]
                if len(child_ports) != 1 or (child_page.source.sheet_id, child_circuit.id) == (page.source.sheet_id, circuit.id):
                    issues.append(f'Port {port.name}: target sheet {port.target_sheet} does not contain one matching declared input port')
                    continue
                child = child_ports[0]
                port.hierarchy_path = [circuit.sheet_name or circuit.sheet_id]
                child.hierarchy_path = [*port.hierarchy_path, port.instance_id or port.target_sheet]
                bindings.append(HierarchyBinding(
                    parent=PortReference(source_sha256=page.source.source_sha256, sheet_id=circuit.sheet_id, circuit_id=circuit.id, port_id=port.id),
                    child=PortReference(source_sha256=child_page.source.source_sha256, sheet_id=child_circuit.sheet_id, circuit_id=child_circuit.id, port_id=child.id)))
    capabilities = [Capability(name='native-sheet-bindings', state='supported' if bindings and not issues else 'unresolved',
        detail=f'{len(bindings)} explicit parent/child port bindings; {len(issues)} unresolved scope observations.', version='cloudx-native-hierarchy/1'),
        Capability(name='electrical-netlist', state='unresolved', detail='Sheet port correspondence does not establish complete device identity or simulation models.')]
    return DocumentPortAnalysis(bindings=bindings, nets=resolve_document_ports(pages, bindings), issues=issues, capabilities=capabilities)
