import io

import pdfplumber
import pytest

from cloudx_documentation_indexer.schematics.pdf_metadata import PdfMetadataLimits, extract_pdf_metadata


class PdfFixture:
    def __init__(self):
        self.objects = []

    def add(self, value=b'null'):
        self.objects.append(value)
        return len(self.objects)

    def set(self, number, value):
        self.objects[number-1] = value

    def bytes(self, catalog):
        output = bytearray(b'%PDF-1.4\n')
        offsets = [0]
        for number, value in enumerate(self.objects, 1):
            offsets.append(len(output))
            output.extend(f'{number} 0 obj\n'.encode()+value+b'\nendobj\n')
        xref = len(output)
        output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
        for offset in offsets[1:]:
            output.extend(f'{offset:010} 00000 n \n'.encode())
        output.extend(f'trailer\n<< /Size {len(offsets)} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF'.encode())
        return bytes(output)


def literal(text):
    return b'('+text.encode().replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)')+b')'


def smart_pdf(*, missing_sheet=False, mutation=None):
    f = PdfFixture()
    catalog=f.add(); pages=f.add(); page=f.add(); extra_page=f.add()
    f.set(pages, f'<< /Type /Pages /Kids [{page} 0 R {extra_page} 0 R] /Count 2 >>'.encode())
    name='ShowCompProps_'+'A'*32
    menu='function '+name+'(){var sChoice = app.popUpMenu("Comment: 10k","Value: 10k");}'
    script=f.add(b'<< /S /JavaScript /JS '+literal(menu)+b' >>')
    names=f.add(b'<< /Names ['+literal(name)+f' {script} 0 R] >>'.encode())
    action=f.add(b'<< /S /JavaScript /JS '+literal(name+'();')+b' >>')
    annotation=f.add(f'<< /Type /Annot /Subtype /Link /Rect [10 20 30 40] /A {action} 0 R >>'.encode())
    f.set(page, f'<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 300 200] /Annots [{annotation} 0 R] >>'.encode())
    f.set(extra_page, f'<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 300 200] /Annots [{annotation} 0 R] >>'.encode())
    outline_root=f.add()
    all_nodes=[]; find_actions=[]

    def outline_node(title, target, token=None, children=()):
        node=f.add(); all_nodes.append(node)
        follow=''
        if token:
            script_action=f.add(b'<< /S /JavaScript /JS '+literal(f'_FindWord({0 if target==page else 1}, "{token}");')+b' >>')
            find_actions.append(script_action)
            follow=f' /Next {script_action} 0 R'
        goto=f.add(f'<< /S /GoTo /D [{target} 0 R /FitR 0 200 300 0]{follow} >>'.encode())
        for left,right in zip(children,children[1:]):
            f.set(left,f.objects[left-1][:-2]+f' /Next {right} 0 R >>'.encode())
        child_field=f' /First {children[0]} 0 R' if children else ''
        f.set(node,b'<< /Title '+literal(title)+f' /A {goto} 0 R{child_field} >>'.encode())
        return node

    def sheet(target):
        pin=outline_node('R1-1',target,'PIR101')
        component=outline_node('R1',target,'COR1',[pin])
        component_group=outline_node('Components',target,children=[component])
        net_pin=outline_node('R1-1',target,'PIR101')
        pins=outline_node('Pins',target,children=[net_pin])
        net=outline_node('VCC',target,children=[pins])
        nets=outline_node('Nets',target,children=[net])
        return outline_node('Board.SchDoc(Board)',target,children=[component_group,nets])

    sheets=[sheet(page)]
    if not missing_sheet:
        sheets.append(sheet(extra_page))
    for left,right in zip(sheets,sheets[1:]):
        f.set(left,f.objects[left-1][:-2]+f' /Next {right} 0 R >>'.encode())
    f.set(outline_root,f'<< /First {sheets[0]} 0 R >>'.encode())
    f.set(catalog,f'<< /Type /Catalog /Pages {pages} 0 R /Outlines {outline_root} 0 R /Names << /JavaScript {names} 0 R >> >>'.encode())
    if mutation:
        mutation(f,locals())
    return f.bytes(catalog)


def extract(content, **limits):
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return extract_pdf_metadata(pdf, 'a'*64, limits=PdfMetadataLimits(**limits))


def test_declared_net_membership_preserves_physical_sheet_scope_and_pdf_object_evidence():
    result=extract(smart_pdf())
    assert result.state=='supported'
    assert {(r.page_number,r.reference,r.token) for r in result.components}=={(1,'R1','COR1'),(2,'R1','COR1')}
    assert {(r.page_number,r.component_reference,r.pin,r.token) for r in result.pins}=={(1,'R1','R1-1','PIR101'),(2,'R1','R1-1','PIR101')}
    assert {(r.page_number,r.name,tuple(r.pin_tokens)) for r in result.nets}=={(1,'VCC',('PIR101',)),(2,'VCC',('PIR101',))}
    assert all(r.evidence.kind=='declared' and r.evidence.outline_object>0 for r in result.pins)
    assert not hasattr(result.pins[0],'bounds')  # FitR is a viewer rectangle.
    assert result.component_menus[0].properties[1].value=='10k'
    assert result.component_menus[0].annotation_rect_pdf==(10,20,30,40)
    assert result.model_dump(mode='json',by_alias=True)['sourceSha256']=='a'*64


def test_missing_physical_sheet_metadata_is_explicit_and_not_copied_from_another_sheet():
    result=extract(smart_pdf(missing_sheet=True))
    assert result.state=='unresolved'
    assert result.pages[1].outline_components==0
    assert result.pages[1].component_menus==1
    assert result.pages[1].state=='unresolved'
    assert [c.page_number for c in result.components]==[1]


def test_plain_pdf_is_unsupported_without_invented_metadata():
    def remove(f,ids):
        f.set(ids['catalog'],f"<< /Type /Catalog /Pages {ids['pages']} 0 R >>".encode())
    result=extract(smart_pdf(mutation=remove))
    assert result.state=='unsupported'
    assert result.components==[]


@pytest.mark.parametrize('mutation',[
    lambda f,i:f.set(i['all_nodes'][0],f.objects[i['all_nodes'][0]-1][:-2]+f" /Next {i['all_nodes'][0]} 0 R >>".encode()),
    lambda f,i:f.set(i['names'],f"<< /Kids [{i['names']} 0 R] >>".encode()),
    lambda f,i:f.set(i['find_actions'][0],b'<< /S /JavaScript /JS '+literal('_FindWord(0, "PIR101");')+f" /Next {i['find_actions'][0]} 0 R >>".encode()),
])
def test_cyclic_metadata_is_failed_without_returning_partial_declarations(mutation):
    result=extract(smart_pdf(mutation=mutation))
    assert result.state=='failed'
    assert result.components==[]
    assert 'Cyclic' in result.issues[0].detail


@pytest.mark.parametrize('limits',[{'max_objects':5},{'max_depth':1},{'max_script_bytes':20},{'max_total_script_bytes':100}])
def test_metadata_budgets_are_explicit_blocked_capabilities(limits):
    result=extract(smart_pdf(),**limits)
    assert result.state=='blocked'
    assert result.components==[]


@pytest.mark.parametrize('javascript',[
    'function ShowCompProps_'+'A'*32+'(){var sChoice = app.popUpMenu("Value: " + dangerous());}',
    'function ShowCompProps_'+'A'*32+'(){var sChoice = app.popUpMenu({value:"10k"});}',
    'function different(){var sChoice = app.popUpMenu("Value: 10k");}',
])
def test_only_named_literal_property_menus_are_accepted(javascript):
    result=extract(smart_pdf(mutation=lambda f,i:f.set(i['script'],b'<< /S /JavaScript /JS '+literal(javascript)+b' >>')))
    assert result.state=='failed'
    assert result.component_menus==[]


def test_destination_and_findword_page_disagreement_is_rejected():
    result=extract(smart_pdf(mutation=lambda f,i:f.set(i['find_actions'][0],b'<< /S /JavaScript /JS '+literal('_FindWord(1, "PIR101");')+b' >>')))
    assert result.state=='failed'
    assert 'page' in result.issues[0].detail.lower()


def test_javascript_streams_are_not_decompressed_or_executed():
    def stream(f,i):
        payload=f.add(b'<< /Length 4 /Filter /FlateDecode >>\nstream\nxxxx\nendstream')
        f.set(i['script'],f'<< /S /JavaScript /JS {payload} 0 R >>'.encode())
    result=extract(smart_pdf(mutation=stream))
    assert result.state=='unsupported'
    assert 'literal' in result.issues[0].detail


def test_nonfinite_annotation_geometry_is_rejected():
    def malformed(f,i):
        f.set(i['annotation'],f"<< /Subtype /Link /Rect [10 20 30 (oops)] /A {i['action']} 0 R >>".encode())
    result=extract(smart_pdf(mutation=malformed))
    assert result.state=='failed'
    assert result.component_menus==[]


def test_missing_menu_is_failed_instead_of_silently_dropping_component_properties():
    def missing(f,i):
        f.set(i['action'],b'<< /S /JavaScript /JS '+literal('ShowCompProps_'+'B'*32+'();')+b' >>')
    result=extract(smart_pdf(mutation=missing))
    assert result.state=='failed'
    assert 'missing' in result.issues[0].detail


def test_unrecognized_outline_action_is_explicitly_unsupported():
    def unknown(f,i):
        f.set(i['find_actions'][0],b'<< /S /JavaScript /JS '+literal('runAnything();')+b' >>')
    result=extract(smart_pdf(mutation=unknown))
    assert result.state=='unsupported'
    assert result.pins==[]


def test_net_membership_cannot_point_to_a_different_pin_token():
    def missing(f,i):
        f.set(i['find_actions'][2],b'<< /S /JavaScript /JS '+literal('_FindWord(0, "PIR199");')+b' >>')
    result=extract(smart_pdf(mutation=missing))
    assert result.state=='failed'
    assert 'membership' in result.issues[0].detail


def test_indirect_reference_cycles_are_bounded_before_resolving_tree_nodes():
    def cycle(f,i):
        f.set(i['names'],f"{i['names']} 0 R".encode())
    result=extract(smart_pdf(mutation=cycle))
    assert result.state=='failed'
    assert 'Cyclic' in result.issues[0].detail


def test_duplicate_menu_names_are_rejected():
    def duplicate(f,i):
        f.set(i['names'],b'<< /Names ['+literal(i['name'])+f" {i['script']} 0 R ".encode()+literal(i['name'])+f" {i['script']} 0 R] >>".encode())
    result=extract(smart_pdf(mutation=duplicate))
    assert result.state=='failed'
    assert 'Duplicate' in result.issues[0].detail


def test_declared_metadata_does_not_need_page_layout_or_text_parsing(monkeypatch):
    def forbidden(*args):
        raise AssertionError('Metadata extraction must not parse page text')
    monkeypatch.setattr(pdfplumber.page.Page, 'parse_objects', forbidden)
    assert extract(smart_pdf()).state=='supported'


@pytest.mark.parametrize('limits',[{'max_properties':1},{'max_string_bytes':1}])
def test_literal_property_size_and_count_have_explicit_limits(limits):
    assert extract(smart_pdf(),**limits).state=='blocked'


@pytest.mark.parametrize('argument',['['*5000+'0'+']'*5000, '"Value: \\ud800"'])
def test_deep_nonliteral_arguments_and_invalid_unicode_fail_without_parser_recursion(argument):
    def invalid(f,i):
        script='function '+i['name']+'(){var sChoice = app.popUpMenu('+argument+');}'
        f.set(i['script'],b'<< /S /JavaScript /JS '+literal(script)+b' >>')
    assert extract(smart_pdf(mutation=invalid)).state=='failed'


def test_ordinary_programming_errors_are_not_mislabeled_as_bad_pdf(monkeypatch):
    from cloudx_documentation_indexer.schematics.pdf_metadata import PdfMetadataReader
    def bug(*args):
        raise RuntimeError('test programming error')
    monkeypatch.setattr(PdfMetadataReader,'coverage',bug)
    with pytest.raises(RuntimeError,match='programming error'):
        extract(smart_pdf())
