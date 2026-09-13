import pytest

from cloudx_documentation_indexer.schematics.domain import Bounds, CircuitGraph, Evidence, Net, Point, Port, SchematicPageAnalysis, SourceGeometry
from cloudx_documentation_indexer.schematics.scope import HierarchyBinding, PortReference, resolve_document_ports, resolve_native_document_ports


def page(sheet, scope="unresolved", hierarchy=(), design=None):
    source = SourceGeometry(source_sha256="a" * 64, page_number=int(sheet), sheet_id=sheet, image_path=f"{sheet}.png",
        image_width=10, image_height=10, page_bounds=Bounds(left=0, top=0, right=10, bottom=10))
    port = Port(id="port", name="VCC", net_id="net", position=Point(x=0, y=0), scope=scope, hierarchy_path=list(hierarchy),
                state="unresolved" if scope == "unresolved" else "supported", evidence=[Evidence(kind="declared", locator="test design declaration")])
    return SchematicPageAnalysis(source=source, capabilities=[], circuits=[CircuitGraph(id="circuit", sheet_id=sheet, design_id=design,
        nets=[Net(id="net", terminal_ids=[])], ports=[port])])


@pytest.mark.parametrize("scope", ["unresolved", "local"])
def test_equal_labels_on_different_sheets_do_not_imply_a_connection(scope):
    assert len(resolve_document_ports([page("1", scope), page("2", scope)], [])) == 2


def test_declared_global_ports_connect_only_within_one_design():
    pages = [page("1", "global", design="board-a"), page("2", "global", design="board-a"), page("3", "global", design="board-b")]
    nets = resolve_document_ports(pages, [])
    assert sorted(len(net.members) for net in nets) == [1, 2]


def test_global_port_without_design_scope_is_rejected():
    with pytest.raises(ValueError, match="electrical design scope"):
        resolve_document_ports([page("1", "global")], [])


def test_hierarchical_binding_selects_a_specific_child_instance():
    pages = [page("1", "hierarchical", ["root"], "board"), page("2", "hierarchical", ["root", "a"], "board"),
             page("3", "hierarchical", ["root", "b"], "board")]
    binding = HierarchyBinding(parent=PortReference(source_sha256="a" * 64, sheet_id="1", circuit_id="circuit", port_id="port"),
        child=PortReference(source_sha256="a" * 64, sheet_id="2", circuit_id="circuit", port_id="port"))
    nets = resolve_document_ports(pages, [binding])
    assert {frozenset(member.sheet_id for member in net.members) for net in nets} == {frozenset({"1", "2"}), frozenset({"3"})}


def test_hierarchical_binding_cannot_cross_an_unrelated_instance_path():
    pages = [page("1", "hierarchical", ["root"], "board"), page("2", "hierarchical", ["unrelated", "a"], "board")]
    binding = HierarchyBinding(parent=PortReference(source_sha256="a" * 64, sheet_id="1", circuit_id="circuit", port_id="port"),
        child=PortReference(source_sha256="a" * 64, sheet_id="2", circuit_id="circuit", port_id="port"))
    with pytest.raises(ValueError, match="instance path"):
        resolve_document_ports(pages, [binding])


def source_declared_parent_and_child():
    parent, child = page("1", "hierarchical", design="board"), page("2", "hierarchical", design="board")
    parent.circuits[0].sheet_name = "TOP.SchDoc"
    parent.circuits[0].ports[0].target_sheet = "CHILD.SchDoc"
    parent.circuits[0].ports[0].instance_id = "U_CHILD"
    child.circuits[0].sheet_name = "CHILD.SchDoc"
    return parent, child


def test_source_declared_target_sheet_connects_one_named_child_port():
    parent, child = source_declared_parent_and_child()
    result = resolve_native_document_ports([parent, child])
    assert len(result.bindings) == 1
    assert len(result.nets) == 1
    assert not result.issues
    assert parent.circuits[0].ports[0].hierarchy_path == []


def test_repeated_child_filenames_preserve_all_nets_without_guessing_instance():
    parent, child = source_declared_parent_and_child()
    repeated = page("3", "hierarchical", design="board")
    repeated.circuits[0].sheet_name = "CHILD.SchDoc"
    result = resolve_native_document_ports([parent, child, repeated])
    assert result.bindings == []
    assert len(result.nets) == 3
    assert "repeated" in result.issues[0]


def test_child_port_name_mismatch_is_retained_as_unresolved_scope():
    parent, child = source_declared_parent_and_child()
    child.circuits[0].ports[0].name = "DIFFERENT"
    result = resolve_native_document_ports([parent, child])
    assert result.bindings == []
    assert len(result.nets) == 2
    assert "matching declared input" in result.issues[0]
